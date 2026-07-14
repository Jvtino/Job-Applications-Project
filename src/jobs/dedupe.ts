import { createHash } from "node:crypto";
import { dedupKeyForUrl } from "../db/applications-repo";

export interface DedupeCandidate {
  company: string;
  title: string;
  location?: string | null;
  jobUrl: string;
  atsType?: string | null;
  description?: string | null;
}

export interface DedupeSignalScores {
  sameUrl: number;
  atsIdentifier: number;
  companyTitleLocation: number;
  description: number;
  remoteLocationCompatible: number;
}

export interface DedupeDecision {
  confidence: number;
  decision: "merge" | "probable_duplicate" | "review" | "distinct";
  signals: DedupeSignalScores;
  fingerprint?: string;
}

export function dedupeConfidence(a: DedupeCandidate, b: DedupeCandidate): DedupeDecision {
  const sameUrl = dedupKeyForUrl(a.jobUrl) === dedupKeyForUrl(b.jobUrl) ? 0.9 : 0;
  const atsIdentifier = stablePostingIdentifier(a.jobUrl) && stablePostingIdentifier(a.jobUrl) === stablePostingIdentifier(b.jobUrl) ? 0.25 : 0;
  const companyTitleLocation = companyTitleLocationScore(a, b);
  const description = descriptionSimilarity(a.description, b.description) * 0.35;
  const remoteLocationCompatible = locationsCompatible(a.location, b.location) ? 0.1 : 0;
  const confidence = roundConfidence(Math.min(1, sameUrl + atsIdentifier + companyTitleLocation + description + remoteLocationCompatible));
  return {
    confidence,
    decision:
      confidence >= 0.9 ? "merge" :
      confidence >= 0.75 ? "probable_duplicate" :
      confidence >= 0.55 ? "review" :
      "distinct",
    signals: {
      sameUrl,
      atsIdentifier,
      companyTitleLocation,
      description: roundConfidence(description),
      remoteLocationCompatible,
    },
    ...(a.description || b.description ? { fingerprint: descriptionFingerprint(a.description ?? b.description ?? "") } : {}),
  };
}

export function descriptionFingerprint(text: string): string {
  const tokens = normalizedTokens(text).slice(0, 160).join(" ");
  return createHash("sha256").update(tokens).digest("hex").slice(0, 16);
}

function companyTitleLocationScore(a: DedupeCandidate, b: DedupeCandidate): number {
  const company = normalizedPhrase(a.company) && normalizedPhrase(a.company) === normalizedPhrase(b.company);
  const title = titleSimilarity(a.title, b.title);
  if (!company || title < 0.82) return 0;
  if (locationsCompatible(a.location, b.location)) return 0.45;
  if (!a.location || !b.location) return 0.25;
  return 0;
}

function titleSimilarity(a: string, b: string): number {
  const at = new Set(normalizedTokens(a));
  const bt = new Set(normalizedTokens(b));
  return jaccard(at, bt);
}

function descriptionSimilarity(a?: string | null, b?: string | null): number {
  if (!a || !b || a.length < 80 || b.length < 80) return 0;
  return jaccard(new Set(normalizedTokens(a)), new Set(normalizedTokens(b)));
}

function stablePostingIdentifier(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    const jk = u.searchParams.get("jk");
    if (jk) return `indeed:${jk.toLowerCase()}`;
    const parts = u.pathname.split("/").filter(Boolean);
    const jobsIdx = parts.findIndex((p) => /^jobs?$/i.test(p));
    const next = jobsIdx >= 0 ? parts[jobsIdx + 1] : undefined;
    if (next && /^[a-z0-9-]{5,}$/i.test(next)) return `${u.hostname}:${next.toLowerCase()}`;
    const viewIdx = parts.findIndex((p) => /^view$/i.test(p));
    const viewId = viewIdx >= 0 ? parts[viewIdx + 1] : undefined;
    if (viewId && /^[a-z0-9-]{3,}$/i.test(viewId)) return `${u.hostname}:${viewId.toLowerCase()}`;
  } catch {
    /* not a URL */
  }
  return undefined;
}

function locationsCompatible(a?: string | null, b?: string | null): boolean {
  const an = normalizedPhrase(a ?? "");
  const bn = normalizedPhrase(b ?? "");
  if (!an || !bn) return true;
  const aRemote = /\b(remote|united states|us|usa)\b/.test(an);
  const bRemote = /\b(remote|united states|us|usa)\b/.test(bn);
  if (aRemote && bRemote) return true;
  return an === bn;
}

function normalizedPhrase(s: string): string {
  return normalizedTokens(s).join(" ");
}

function normalizedTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function roundConfidence(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const STOP = new Set([
  "the", "and", "for", "with", "from", "this", "that", "you", "your", "our", "are", "will",
  "job", "jobs", "role", "position", "work", "team", "candidate", "candidates", "company",
  "inc", "llc", "corp", "corporation",
]);
