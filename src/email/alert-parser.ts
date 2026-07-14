/**
 * Email job-alert parser — the module's public entry point.
 *
 * Reads LinkedIn/Indeed job-alert emails the user has exported to files
 * (.eml / .mbox) and emits finder `RawJob` records. Personal-data safe: it
 * stores METADATA + LINKS ONLY. The email body is never returned or retained —
 * `descriptionRaw` is always `''` and nothing else carries body text.
 *
 * No network, no credentials, no IMAP. Node built-ins + this module only.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RawJob } from '../finder/shared';
import { parseMessage, splitMbox } from './mime';
import {
  canonicalizeJobLink,
  detectProvider,
  jobUrlPattern,
  providerToSourceType,
  type Provider,
} from './alert-sources';

export interface AlertJob {
  raw: RawJob;
  sourceType: 'assisted_linkedin' | 'assisted_indeed';
}

/**
 * Parse a single raw email. Returns `[]` for anything that isn't a recognized
 * LinkedIn/Indeed alert (the non-alert guard). For an alert, extracts one
 * `RawJob` per distinct job link found in the HTML (falling back to text).
 */
export function parseAlertMessage(rawEmail: string): AlertJob[] {
  let parsed: ReturnType<typeof parseMessage>;
  try {
    parsed = parseMessage(rawEmail);
  } catch {
    return [];
  }

  const provider = detectProvider(parsed.headers);
  if (!provider) return []; // NON-ALERT IGNORED — never emit anything.

  const sourceType = providerToSourceType[provider];
  const body = parsed.html || parsed.text || '';
  const entries = extractEntries(provider, body);
  return entries.map((entry) => ({ raw: buildRawJob(entry), sourceType }));
}

/**
 * Read every `*.eml` and `*.mbox` file directly inside `dir` (non-recursive),
 * parse them, and aggregate the alert jobs. A missing/empty directory yields
 * `[]`; a single bad or unreadable file is skipped rather than throwing.
 */
export function readAlertMail(dir: string): AlertJob[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const results: AlertJob[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const isEml = lower.endsWith('.eml');
    const isMbox = lower.endsWith('.mbox');
    if (!isEml && !isMbox) continue;

    const full = join(dir, name);
    let content: string;
    try {
      if (!statSync(full).isFile()) continue;
      content = readFileSync(full, 'utf8');
    } catch {
      continue; // unreadable file — skip and continue.
    }

    try {
      if (isMbox) {
        for (const message of splitMbox(content)) {
          try {
            results.push(...parseAlertMessage(message));
          } catch {
            // skip an individual malformed mbox message
          }
        }
      } else {
        results.push(...parseAlertMessage(content));
      }
    } catch {
      // skip a bad file entirely
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Internal extraction
// ---------------------------------------------------------------------------

interface JobEntry {
  id: string;
  canonicalUrl: string;
  title: string;
  company: string;
  location: string | null;
}

const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(['"])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

function extractEntries(provider: Provider, html: string): JobEntry[] {
  const byId = new Map<string, JobEntry>();

  // 1) Rich pass: every anchor whose href is a job link. The anchor text is the
  //    best title candidate; the text nodes between it and the next distinct job
  //    anchor are the best-effort company + location.
  const jobAnchors: Array<{ id: string; canonicalUrl: string; title: string; start: number; end: number }> = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const href = decodeHtmlEntities(m[2] ?? '');
    const canon = canonicalizeJobLink(provider, href);
    if (!canon) continue;
    const start = m.index ?? 0;
    jobAnchors.push({
      id: canon.id,
      canonicalUrl: canon.canonicalUrl,
      title: stripTags(m[3] ?? ''),
      start,
      end: start + m[0].length,
    });
  }

  for (let i = 0; i < jobAnchors.length; i++) {
    const a = jobAnchors[i]!;
    // Window runs to the next anchor for a DIFFERENT job (so a same-job "View
    // job" button doesn't cut off the company/location text that precedes it).
    let windowEnd = html.length;
    for (let j = i + 1; j < jobAnchors.length; j++) {
      if (jobAnchors[j]!.id !== a.id) {
        windowEnd = jobAnchors[j]!.start;
        break;
      }
    }
    const nodes = textNodesBetween(html, a.end, windowEnd);
    mergeEntry(byId, {
      id: a.id,
      canonicalUrl: a.canonicalUrl,
      title: a.title,
      company: nodes[0] ?? '',
      location: nodes[1] ?? null,
    });
  }

  // 2) Fallback pass: bare job URLs (e.g. a text/plain body) not already captured.
  for (const m of html.matchAll(jobUrlPattern(provider))) {
    const canon = canonicalizeJobLink(provider, decodeHtmlEntities(m[0]));
    if (!canon || byId.has(canon.id)) continue;
    mergeEntry(byId, {
      id: canon.id,
      canonicalUrl: canon.canonicalUrl,
      title: '',
      company: '',
      location: null,
    });
  }

  return [...byId.values()];
}

/** Insert or enrich an entry, keyed by job id. First non-empty value for each field wins. */
function mergeEntry(byId: Map<string, JobEntry>, entry: JobEntry): void {
  const existing = byId.get(entry.id);
  if (!existing) {
    byId.set(entry.id, { ...entry });
    return;
  }
  if (!existing.title && entry.title) existing.title = entry.title;
  if (!existing.company && entry.company) existing.company = entry.company;
  if (!existing.location && entry.location) existing.location = entry.location;
}

function buildRawJob(entry: JobEntry): RawJob {
  return {
    externalJobId: entry.id,
    company: entry.company,
    title: entry.title,
    locationRaw: entry.location,
    descriptionRaw: '', // never carry the email body
    applyUrl: entry.canonicalUrl,
    canonicalUrl: entry.canonicalUrl,
    postedAt: null,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: 'unknown',
    remoteType: 'unknown',
    employmentType: 'unknown',
    extra: {},
  };
}

/** Text nodes (content between `>` and `<`) within a slice, decoded + trimmed, empties dropped. */
function textNodesBetween(html: string, start: number, end: number): string[] {
  const slice = html.slice(start, Math.max(start, end));
  const nodes: string[] = [];
  const re = />([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    const text = decodeHtmlEntities(m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (text) nodes.push(text);
  }
  return nodes;
}

function stripTags(input: string): string {
  return decodeHtmlEntities(input.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeCodePoint(parseInt(h, 16)));
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}
