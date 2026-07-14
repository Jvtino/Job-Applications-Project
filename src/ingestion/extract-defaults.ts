// src/ingestion/extract-defaults.ts
//
// Best-effort extraction of target-role / location / compensation DEFAULTS from the parsed
// resume, to satisfy the brief's §7 step ("extract defaults from my resume and confirm them
// with me"). These are SUGGESTIONS only — the ingest flow surfaces them for explicit user
// confirmation before anything is written to the profile.

import type { Fact } from "../types/facts-ledger";

export interface ExtractedDefaults {
  targetRoles: string[];
  locations: string[];
  compensation?: { min?: number; max?: number };
  workModes?: ("remote" | "hybrid" | "onsite")[];
}

const US_STATE = /\b([A-Z]{2})\b/;
const SALARY = /\$\s?(\d{2,3}(?:,\d{3})?|\d{2,3})\s?[kK]?(?:\s?-\s?\$?\s?(\d{2,3}(?:,\d{3})?|\d{2,3})\s?[kK]?)?/;
const ASPIRATIONAL =
  /\b(seeking|looking for|open to|targeting|interested in|pursuing)\b[^.\n]{0,80}\b(role|position|opportunit)/i;
const ROLE_LINE =
  /\b(product manager|product owner|program manager|project manager|software engineer|software developer|backend engineer|frontend engineer|full[- ]?stack( engineer| developer)?|data (scientist|analyst|engineer)|machine learning engineer|ml engineer|ai engineer|research scientist|designer|ux designer|ui designer|product designer|marketing manager|growth manager|demand generation|brand manager|content (strategist|manager)|operations (manager|analyst|lead)|business analyst|financial analyst|engineering manager|technical lead|tech lead|staff engineer|principal engineer|solutions (architect|engineer)|sales (engineer|manager|representative)|account (executive|manager)|customer success|devops( engineer)?|site reliability|sre|platform engineer|security engineer|infrastructure engineer|cloud engineer|qa engineer|test engineer|frontend|backend|growth|revenue|gtm|sales|analyst)\b/i;

export function extractDefaults(facts: Fact[], rawText: string): ExtractedDefaults {
  const titles: string[] = [];
  const locations: string[] = [];
  const aspirational: string[] = [];

  for (const f of facts) {
    if (f.type === "employment") {
      if (f.title && f.title !== "Unknown title") titles.push(f.title.trim());
      if (f.location) locations.push(f.location.trim());
    }
    // Summary lines and skills often name the target role better than past titles alone.
    // (Previously this checked f.type === "generic", which is not a real FactType — dead code.)
    if ((f.type === "summary_point" || f.type === "skill" || f.type === "achievement") && ROLE_LINE.test(f.statement)) {
      aspirational.push(f.statement.trim());
    }
  }

  // Headline / summary lines often state target role better than past titles alone.
  for (const line of rawText.split("\n").slice(0, 20)) {
    const t = line.trim();
    if (!t || t.length > 120) continue;
    if (ASPIRATIONAL.test(t) || ROLE_LINE.test(t)) aspirational.push(t);
  }

  const cityState = rawText.match(/([A-Z][a-zA-Z.\- ]+),\s*([A-Z]{2})\b/);
  if (cityState) locations.push(`${cityState[1]!.trim()}, ${cityState[2]}`);

  const comp = parseCompensation(rawText);
  const workModes = parseWorkModes(rawText);

  const targetRoles = dedupe([...aspirational.map(extractRolePhrase), ...titles]).slice(0, 6);

  return {
    targetRoles,
    locations: dedupe(locations).slice(0, 5),
    ...(comp ? { compensation: comp } : {}),
    ...(workModes.length ? { workModes } : {}),
  };
}

function extractRolePhrase(line: string): string {
  const m = line.match(ROLE_LINE);
  if (m) return titleCaseRole(m[0]!);
  const cleaned = line.replace(ASPIRATIONAL, "").replace(/[:\-—|]+/g, " ").trim();
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 60).trim();
}

function titleCaseRole(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseWorkModes(text: string): ("remote" | "hybrid" | "onsite")[] {
  const modes: ("remote" | "hybrid" | "onsite")[] = [];
  const blob = text.slice(0, 4000).toLowerCase();
  if (/\b(remote|work from home|wfh|distributed)\b/.test(blob)) modes.push("remote");
  if (/\bhybrid\b/.test(blob)) modes.push("hybrid");
  if (/\bon[- ]?site\b|\bin[- ]office\b/.test(blob)) modes.push("onsite");
  return dedupe(modes) as ("remote" | "hybrid" | "onsite")[];
}

function parseCompensation(text: string): { min?: number; max?: number } | undefined {
  const m = text.match(SALARY);
  if (!m) return undefined;
  const min = normalizeSalary(m[1]);
  const max = normalizeSalary(m[2]);
  if (min === undefined && max === undefined) return undefined;
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function normalizeSalary(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return n < 1000 ? n * 1000 : n;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
