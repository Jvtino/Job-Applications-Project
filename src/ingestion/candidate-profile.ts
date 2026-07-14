// src/ingestion/candidate-profile.ts
//
// Build a recruiter-grade CandidateProfile from approved facts (+ the applicant profile when
// available). Deterministic and offline; an LLM can enrich it later (see src/ai/job-reasoner.ts),
// but this base always works. This is INFERENCE FOR MATCHING ONLY — never a résumé claim and never
// fed to document generation (that remains the approved facts ledger's job).

import type { Fact } from "../types/facts-ledger";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { CandidateProfile, SkillEvidence } from "../types/job-fit";
import { seniorityBandFor } from "../types/job-fit";
import {
  canonicalSkill,
  extractSkillsFromText,
  roleFamilies,
  detectIndustries,
  degreeLevelOf,
  seniorityLevel,
} from "../jobs/taxonomy";

const SOFT_SKILLS = [
  "communication", "leadership", "collaboration", "teamwork", "problem solving", "analytical",
  "organization", "attention to detail", "time management", "adaptability", "mentoring", "negotiation",
  "presentation", "stakeholder management", "critical thinking",
];

// A pragmatic set of "tool/software" canonical skills, so we can split tools out of hard skills.
const TOOL_HINTS = new Set([
  "excel", "sql", "python", "tableau", "power bi", "salesforce", "sap", "quickbooks", "jira",
  "confluence", "git", "docker", "kubernetes", "aws", "gcp", "azure", "snowflake", "databricks",
  "looker", "r", "sas", "spss", "netsuite", "workday", "servicenow", "figma", "photoshop", "hubspot",
]);

function yearOf(s: string | undefined): number | null {
  if (!s) return null;
  if (/present|current|now|ongoing/i.test(s)) return new Date().getFullYear();
  const m = s.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

interface Interval {
  start: number;
  end: number;
}

/** Merge overlapping [start,end] intervals and sum their span (overlap-safe). */
function mergedYears(intervals: Interval[]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = sorted[0]!.start;
  let curEnd = sorted[0]!.end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i]!;
    if (iv.start <= curEnd) curEnd = Math.max(curEnd, iv.end);
    else {
      total += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  total += curEnd - curStart;
  return Math.max(0, Math.min(60, total));
}

function employmentIntervals(facts: Fact[]): { fact: Fact; iv: Interval }[] {
  const nowYear = new Date().getFullYear();
  const out: { fact: Fact; iv: Interval }[] = [];
  for (const f of facts) {
    if (f.type !== "employment") continue;
    const start = yearOf(f.startDate);
    const end = yearOf(f.endDate) ?? nowYear;
    if (start !== null && end >= start) out.push({ fact: f, iv: { start, end } });
  }
  return out;
}

/** Years of experience attributable to each role family (overlap-deduped within a family). */
function yearsByArea(facts: Fact[]): Record<string, number> {
  const buckets = new Map<string, Interval[]>();
  for (const { fact, iv } of employmentIntervals(facts)) {
    const e = fact as Extract<Fact, { type: "employment" }>;
    const fams = roleFamilies(e.title, (e.bullets ?? []).join(" "));
    for (const fam of fams) {
      if (!buckets.has(fam)) buckets.set(fam, []);
      buckets.get(fam)!.push(iv);
    }
  }
  const out: Record<string, number> = {};
  for (const [fam, ivs] of buckets) out[fam] = mergedYears(ivs);
  return out;
}

function computeSkills(facts: Fact[]): SkillEvidence[] {
  const mentions = new Map<string, number>();
  const fromSkillSection = new Set<string>();
  const bump = (name: string, by: number) => mentions.set(name, (mentions.get(name) ?? 0) + by);

  for (const f of facts) {
    if (f.type === "skill") {
      const c = canonicalSkill(f.statement);
      if (c) {
        bump(c, 3);
        fromSkillSection.add(c);
      }
    }
  }
  for (const f of facts) {
    if (f.type !== "employment") continue;
    for (const b of f.bullets ?? []) {
      for (const [name, n] of extractSkillsFromText(b)) bump(name, n);
    }
  }

  return [...mentions.entries()]
    .map(([name, count]): SkillEvidence => {
      const strength: SkillEvidence["strength"] =
        fromSkillSection.has(name) || count >= 3 ? "strong" : count === 2 ? "moderate" : "weak";
      return { name, strength, mentions: count };
    })
    .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
    .slice(0, 60);
}

function computeSeniority(facts: Fact[], totalYears: number): number {
  let level = 0;
  let sawEmployment = false;
  for (const f of facts) {
    if (f.type === "employment") {
      sawEmployment = true;
      level = Math.max(level, seniorityLevel(f.title));
    }
  }
  if (!sawEmployment) return 2;
  // Tenure floor: a real career with no senior title still isn't an intern.
  if (totalYears >= 8) level = Math.max(level, 3);
  else if (totalYears >= 4) level = Math.max(level, 2);
  else if (level === 0) level = 1;
  return level;
}

function dealbreakersFrom(profile?: ApplicantProfile): string[] {
  const out: string[] = [];
  if (!profile) return out;
  const p = profile.preferences;
  if (p.willingToRelocate.value === false) out.push("will not relocate");
  if (!p.compensation.isNegotiable && p.compensation.desiredBaseMin) {
    out.push(`base comp floor ~$${Math.round(p.compensation.desiredBaseMin / 1000)}k`);
  }
  const modes = Array.isArray(p.workModePreference.value) ? p.workModePreference.value : [];
  if (modes.length && !modes.includes("onsite")) out.push(`work mode: ${modes.join("/")} only`);
  if (profile.workAuthorization.requiresSponsorshipNowOrFuture.value === true) {
    out.push("requires visa sponsorship");
  }
  return out;
}

function riskFactorsFrom(facts: Fact[], totalYears: number, education: { level: number }[]): string[] {
  const out: string[] = [];
  const jobs = employmentIntervals(facts);
  if (totalYears > 0 && totalYears < 2) out.push("limited total professional tenure");
  const shortStints = jobs.filter(({ iv }) => iv.end - iv.start < 1).length;
  if (jobs.length >= 3 && shortStints >= 2) out.push("several short tenures (possible job-hopping flag)");
  if (jobs.length === 0) out.push("no employment history parsed");
  if (!education.some((e) => e.level >= 2)) out.push("no bachelor's degree detected");
  return out;
}

function careerDirectionFrom(profile: ApplicantProfile | undefined, titles: string[]): string {
  if (profile?.positioning?.whatIDo?.trim()) return profile.positioning.whatIDo.trim();
  const targets = profile?.preferences.targetRoles ?? [];
  if (targets.length && titles.length) {
    const moving = targets.some((t) => !titles.some((ti) => ti.toLowerCase() === t.toLowerCase()));
    if (moving) return `transitioning toward ${targets.slice(0, 2).join(" / ")}`;
    return `continuing as ${targets[0]}`;
  }
  if (titles.length) return `continuing in ${titles[0]}`;
  return "open / unspecified";
}

/** Build the deterministic candidate profile. `profile` is optional (tests can pass facts only). */
export function buildCandidateProfile(
  profileId: string,
  facts: Fact[],
  profile?: ApplicantProfile
): CandidateProfile {
  const byArea = yearsByArea(facts);
  const totalYears = mergedYears(employmentIntervals(facts).map((x) => x.iv));
  const seniority = computeSeniority(facts, totalYears);

  const titles: string[] = [];
  const seenTitle = new Set<string>();
  for (const f of facts) {
    if (f.type === "employment" && f.title && f.title !== "Unknown title") {
      const key = f.title.toLowerCase();
      if (!seenTitle.has(key)) {
        seenTitle.add(key);
        titles.push(f.title);
      }
    }
  }

  const hardSkills = computeSkills(facts);
  const allText = facts
    .map((f) =>
      f.type === "employment"
        ? `${f.title} ${(f.bullets ?? []).join(" ")}`
        : "statement" in f
          ? (f as { statement: string }).statement
          : ""
    )
    .join(" ")
    .toLowerCase();

  const softSkills = SOFT_SKILLS.filter((s) => allText.includes(s));
  const toolsAndSoftware = hardSkills.filter((s) => TOOL_HINTS.has(s.name)).map((s) => s.name);
  const certifications = facts
    .filter((f): f is Extract<Fact, { type: "certification" }> => f.type === "certification")
    .map((f) => f.name);
  const education = facts
    .filter((f): f is Extract<Fact, { type: "education" }> => f.type === "education")
    .map((f) => ({
      degree: f.degree,
      ...(f.field ? { field: f.field } : {}),
      level: degreeLevelOf(`${f.degree} ${f.field ?? ""}`),
    }));

  const strong: string[] = [];
  const moderate: string[] = [];
  for (const [area, years] of Object.entries(byArea)) {
    if (years >= 3) strong.push(area);
    else if (years >= 1) moderate.push(area);
  }
  // Areas implied only by skills (not employment) = adjacent, not direct → "weak/missing".
  const employmentAreas = new Set([...strong, ...moderate]);
  const skillAreas = roleFamilies("", hardSkills.map((s) => s.name).join(" "));
  const weakOrMissing = [...skillAreas].filter((a) => !employmentAreas.has(a));

  const industries = [...new Set(detectIndustries(allText))];
  const preferredRoles = profile?.preferences.targetRoles?.length
    ? [...profile.preferences.targetRoles]
    : titles.slice(0, 3);

  const wa = profile?.workAuthorization;
  const workAuthorization = !wa
    ? "unspecified"
    : wa.requiresSponsorshipNowOrFuture.value === true
      ? "authorized; requires sponsorship"
      : wa.authorizedToWorkInUS.value === true
        ? "authorized to work in the US, no sponsorship"
        : "unspecified";

  return {
    profileId,
    jobTitles: titles.slice(0, 8),
    industries,
    hardSkills,
    softSkills,
    toolsAndSoftware,
    certifications,
    education,
    yearsOfExperienceByArea: byArea,
    totalYearsExperience: totalYears,
    strongExperienceAreas: strong,
    moderateExperienceAreas: moderate,
    weakOrMissingAreas: weakOrMissing,
    preferredRoles,
    likelySeniorityLevel: seniority,
    likelySeniorityBand: seniorityBandFor(seniority),
    locationConstraints: profile?.preferences.desiredLocations ?? [],
    workAuthorization,
    dealbreakers: dealbreakersFrom(profile),
    resumeRiskFactors: riskFactorsFrom(facts, totalYears, education),
    careerDirection: careerDirectionFrom(profile, titles),
    method: "deterministic",
    generatedAt: new Date().toISOString(),
  };
}
