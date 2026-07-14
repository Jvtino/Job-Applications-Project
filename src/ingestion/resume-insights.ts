// src/ingestion/resume-insights.ts
//
// Deterministic computation of ResumeInsights from parsed facts. Pure inference for MATCHING only
// (never a résumé claim, never used in generation). Free and offline.

import type { Fact } from "../types/facts-ledger";
import type { ResumeInsights, ResumeSkillSignal } from "../types/resume-insights";
import { roleFamilies, seniorityLevel } from "../jobs/role-keywords";

// Indices align with seniorityLevel() in role-keywords.ts: 0 intern .. 6 vp.
const SENIORITY_LABELS = ["intern", "junior", "mid", "senior", "staff/lead", "director", "vp"];
const STOP = new Set([
  "the", "and", "for", "with", "from", "that", "this", "using", "used", "across", "into", "over",
  "team", "teams", "work", "working", "experience", "years", "year", "skills", "including",
]);

function yearOf(s: string | undefined): number | null {
  if (!s) return null;
  if (/present|current|now|ongoing/i.test(s)) return new Date().getFullYear();
  const m = s.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

/** Merge overlapping employment intervals and return total years (overlap-safe). */
function computeYearsExperience(facts: Fact[]): number {
  const nowYear = new Date().getFullYear();
  const intervals: { start: number; end: number }[] = [];
  for (const f of facts) {
    if (f.type !== "employment") continue;
    const start = yearOf(f.startDate);
    const end = yearOf(f.endDate) ?? nowYear;
    if (start !== null && end >= start) intervals.push({ start, end });
  }
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = intervals[0]!.start;
  let curEnd = intervals[0]!.end;
  for (let i = 1; i < intervals.length; i++) {
    const iv = intervals[i]!;
    if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  total += curEnd - curStart;
  return Math.max(0, Math.min(60, total));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

function computeSkills(facts: Fact[]): ResumeSkillSignal[] {
  const counts = new Map<string, number>();
  const bump = (raw: string, weight: number) => {
    const name = raw.trim();
    if (name.length < 2) return;
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + weight);
  };
  for (const f of facts) {
    if (f.type === "skill") bump(f.statement, 3);
  }
  // Lighter signal from employment bullets (only multi-char tokens, deduped per bullet).
  for (const f of facts) {
    if (f.type !== "employment") continue;
    for (const b of f.bullets ?? []) {
      for (const t of new Set(tokenize(b))) bump(t, 1);
    }
  }
  return [...counts.entries()]
    .map(([name, mentions]) => ({ name, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
    .slice(0, 40);
}

function computeDomains(facts: Fact[]): string[] {
  const domains = new Set<string>();
  for (const f of facts) {
    if (f.type === "employment") for (const d of roleFamilies(f.title)) domains.add(d);
  }
  // Skill-driven domain hints for backgrounds whose titles are generic.
  const skillText = facts
    .filter((f) => f.type === "skill")
    .map((f) => (f as { statement: string }).statement.toLowerCase())
    .join(" ");
  if (/\b(security|infosec|appsec|soc|siem)\b/.test(skillText)) domains.add("security");
  if (/\b(sql|spark|etl|warehouse|analytics|pandas)\b/.test(skillText)) domains.add("data");
  if (/\b(kubernetes|terraform|aws|gcp|azure|ci\/cd|devops)\b/.test(skillText)) domains.add("infrastructure");
  return [...domains];
}

/** Degrees the résumé states, so a posting's degree requirement can be scored. */
function computeEducation(
  facts: Fact[],
): Array<{ degree: string | null; institution: string | null; year: string | null }> {
  const out: Array<{ degree: string | null; institution: string | null; year: string | null }> = [];
  for (const f of facts) {
    if (f.type !== "education") continue;
    const e = f as Extract<Fact, { type: "education" }>;
    out.push({
      degree: e.degree || null,
      institution: e.institution || null,
      year: ("graduationDate" in e && e.graduationDate) || null,
    });
  }
  return out;
}

function computeSeniority(facts: Fact[]): { level: number; label: string } {
  let level = 2; // default mid
  for (const f of facts) {
    if (f.type === "employment") level = Math.max(level, seniorityLevel(f.title));
  }
  const label = SENIORITY_LABELS[Math.min(level, SENIORITY_LABELS.length - 1)] ?? "mid";
  return { level, label };
}

/** Compute deterministic insights from parsed/approved facts. */
export function computeResumeInsights(facts: Fact[]): ResumeInsights {
  const { level, label } = computeSeniority(facts);
  const topTitles: string[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.type === "employment" && f.title && f.title !== "Unknown title") {
      const key = f.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        topTitles.push(f.title);
      }
    }
  }
  return {
    totalYearsExperience: computeYearsExperience(facts),
    seniorityLevel: level,
    seniorityLabel: label,
    domains: computeDomains(facts),
    skills: computeSkills(facts),
    topTitles: topTitles.slice(0, 8),
    education: computeEducation(facts),
    method: "deterministic",
    generatedAt: new Date().toISOString(),
  };
}
