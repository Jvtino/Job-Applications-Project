// src/jobs/job-search-intent.ts
//
// resolveJobSearchIntent — THE single canonical resolver for "what is this person looking for".
// Every path that needs the target (discovery, query planning, scoring) must call this instead of
// each re-deriving targets from a different field, which is how the same résumé used to get
// classified three different ways.
//
// Priority order (brief D2.1), highest-trust first:
//   1. a user-CONFIRMED intent            → confidence "confirmed"
//   2. explicit profile target roles      → "inferred_high"
//   3. dynamic-answer target role         → "inferred_high"
//   4. résumé summary / objective phrase  → "inferred_low"
//   5. recent work titles                 → "inferred_low"
//   6. skills / family inference only     → "inferred_low"
//   7. nothing                            → "missing" (ask the user)
//
// Pivot-aware: where the person has BEEN (currentOrPastTitles) is kept SEPARATE from where they
// want to GO (targetTitles), so a teacher → CX or banker → compliance pivot isn't searched by the
// old title. Domain-general: no role family is privileged.

import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact } from "../types/facts-ledger";
import type { CandidateProfile } from "../types/job-fit";
import type { DynamicQA } from "../types/applicant-profile";
import {
  type JobSearchIntent,
  type IntentConfidence,
  type SeniorityRung,
  intentPermissions,
  rungForLevel,
  rungIndex,
  SENIORITY_RUNGS,
} from "../types/job-search-intent";
import { buildCandidateProfile } from "../ingestion/candidate-profile";
import { roleFamilies, detectIndustries } from "./taxonomy";
import { extractDefaults } from "../ingestion/extract-defaults";
import { targetRolesFromProfile, inferTargetRoles } from "./role-focus";
import { selectRoleFamilyPacks } from "./role-family-pack";

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = raw.trim();
    const k = v.toLowerCase();
    if (v && !seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

/** Did the user explicitly confirm their target? A dynamic answer flag, or an explicit override. */
function intentIsConfirmed(profile: ApplicantProfile): boolean {
  const ans = profile.dynamicAnswers.find((d) => /intent.*confirm|confirm.*(target|intent)|target.*confirmed/i.test(d.key))?.answer;
  return ans === true || ans === "true" || ans === "yes";
}

/** Résumé summary/objective role phrases (aspirational), distinct from work history. */
function aspirationalTitles(facts: Fact[], rawText: string): string[] {
  const defaults = extractDefaults(facts, rawText);
  // extractDefaults already prepends aspirational phrases before history titles; take the ones that
  // are NOT a verbatim past employment title.
  const pastLower = new Set(
    facts.filter((f) => f.type === "employment").map((f) => (f as { title: string }).title.toLowerCase().trim())
  );
  return defaults.targetRoles.filter((t) => !pastLower.has(t.toLowerCase().trim()));
}

function clampRung(i: number): SeniorityRung {
  return SENIORITY_RUNGS[Math.max(0, Math.min(SENIORITY_RUNGS.length - 1, i))]!;
}

function workArrangementFrom(profile: ApplicantProfile): JobSearchIntent["workArrangement"] {
  const modes = Array.isArray(profile.preferences.workModePreference.value) ? profile.preferences.workModePreference.value : [];
  const out: JobSearchIntent["workArrangement"] = [];
  for (const m of modes) {
    if (m === "remote") out.push("remote_us");
    else if (m === "hybrid") out.push("hybrid");
    else if (m === "onsite") out.push("onsite");
  }
  return out.length ? out : ["onsite", "hybrid", "remote_us"];
}

// ----------------------------------------------------------------------------------------
// Persistence of a USER-CONFIRMED intent (brief Part H). Stored as a JSON string in the profile's
// dynamicAnswers under a stable key — no schema migration, and it round-trips through the existing
// encrypted profile blob. A stored confirmed intent is authoritative (confidence "confirmed").
// ----------------------------------------------------------------------------------------

export const INTENT_DYNAMIC_KEY = "job_search_intent";

/** The confirmed intent the user saved, or null if none is stored / it can't be parsed. */
export function storedConfirmedIntent(profile: ApplicantProfile): JobSearchIntent | null {
  const entry = profile.dynamicAnswers.find((d) => d.key === INTENT_DYNAMIC_KEY);
  if (!entry || typeof entry.answer !== "string") return null;
  try {
    const parsed = JSON.parse(entry.answer) as Partial<JobSearchIntent>;
    if (!parsed || parsed.confirmed !== true || !Array.isArray(parsed.targetTitles) || parsed.targetTitles.length === 0) return null;
    return { ...parsed, confirmed: true, confidence: "confirmed" } as JobSearchIntent;
  } catch {
    return null;
  }
}

/** Fields a user can edit when confirming their target (everything else is inferred). */
export interface IntentPatch {
  targetTitles?: string[];
  adjacentTitles?: string[];
  excludedTitles?: string[];
  seniorityMin?: SeniorityRung;
  seniorityMax?: SeniorityRung;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
  requiredCredentials?: string[];
  missingCredentialDealbreakers?: string[];
  industries?: string[];
  companyTypes?: string[];
  locations?: string[];
  workArrangement?: Array<"onsite" | "hybrid" | "remote_us">;
  dealbreakers?: string[];
  compensationMin?: number;
  compensationTarget?: number;
}

/** Merge a user's edits onto an inferred draft to produce a fully-populated CONFIRMED intent. */
export function buildConfirmedIntent(draft: JobSearchIntent, patch: IntentPatch): JobSearchIntent {
  const targetTitles = patch.targetTitles?.length ? dedupe(patch.targetTitles) : draft.targetTitles;
  const adjacentTitles = patch.adjacentTitles ? dedupe(patch.adjacentTitles) : draft.adjacentTitles;
  const roleFamiliesSet = new Set<string>();
  for (const t of [...targetTitles, ...adjacentTitles]) for (const f of roleFamilies(t)) roleFamiliesSet.add(f);
  for (const f of draft.roleFamilies) roleFamiliesSet.add(f);

  const compensation =
    patch.compensationMin !== undefined || patch.compensationTarget !== undefined
      ? {
          currency: "USD" as const,
          ...(patch.compensationMin !== undefined ? { min: patch.compensationMin } : {}),
          ...(patch.compensationTarget !== undefined ? { target: patch.compensationTarget } : {}),
        }
      : draft.compensation;

  return {
    confirmed: true,
    confidence: "confirmed",
    roleFamilies: [...roleFamiliesSet],
    targetTitles,
    adjacentTitles,
    excludedTitles: patch.excludedTitles ? dedupe(patch.excludedTitles) : draft.excludedTitles,
    currentOrPastTitles: draft.currentOrPastTitles,
    seniority: {
      min: patch.seniorityMin ?? draft.seniority.min,
      max: patch.seniorityMax ?? draft.seniority.max,
      evidence: draft.seniority.evidence,
    },
    mustHaveSkills: patch.mustHaveSkills ? dedupe(patch.mustHaveSkills) : draft.mustHaveSkills,
    niceToHaveSkills: patch.niceToHaveSkills ? dedupe(patch.niceToHaveSkills) : draft.niceToHaveSkills,
    transferableSkills: draft.transferableSkills,
    requiredCredentials: patch.requiredCredentials ? dedupe(patch.requiredCredentials) : draft.requiredCredentials,
    missingCredentialDealbreakers: patch.missingCredentialDealbreakers
      ? dedupe(patch.missingCredentialDealbreakers)
      : draft.missingCredentialDealbreakers,
    industries: patch.industries ? dedupe(patch.industries) : draft.industries,
    companyTypes: patch.companyTypes ? dedupe(patch.companyTypes) : draft.companyTypes,
    locations: patch.locations ? dedupe(patch.locations) : draft.locations,
    workArrangement: patch.workArrangement?.length ? patch.workArrangement : draft.workArrangement,
    ...(compensation ? { compensation } : {}),
    dealbreakers: patch.dealbreakers ? dedupe(patch.dealbreakers) : draft.dealbreakers,
  };
}

/**
 * Return a NEW profile with the confirmed intent stored (JSON in dynamicAnswers) and its target
 * titles mirrored into preferences.targetRoles so the rest of the app stays consistent. Pure —
 * the caller persists via ProfileRepo.save.
 */
export function withConfirmedIntent(profile: ApplicantProfile, intent: JobSearchIntent, now = new Date().toISOString()): ApplicantProfile {
  const entry: DynamicQA = {
    key: INTENT_DYNAMIC_KEY,
    questionText: "Confirmed job-search target",
    fieldType: "text",
    answer: JSON.stringify({ ...intent, confirmed: true, confidence: "confirmed" }),
    updatedAt: now,
  };
  const dynamicAnswers = [...profile.dynamicAnswers.filter((d) => d.key !== INTENT_DYNAMIC_KEY), entry];
  return {
    ...profile,
    dynamicAnswers,
    preferences: { ...profile.preferences, targetRoles: dedupe([...intent.targetTitles]) },
    updatedAt: now,
  };
}

export interface ResolveIntentInput {
  profile: ApplicantProfile;
  facts: Fact[];
  /** Raw résumé text, if available, to mine the summary/objective for aspirational targets. */
  rawText?: string;
  /** Pre-built candidate profile (avoids recompute); built from facts if omitted. */
  candidate?: CandidateProfile;
}

/**
 * Resolve the canonical JobSearchIntent from a profile + approved facts. Deterministic and
 * side-effect-free. The returned `confidence` governs how far automation may go (see
 * intentPermissions).
 */
export function resolveJobSearchIntent(input: ResolveIntentInput): JobSearchIntent {
  const { profile, facts } = input;
  // Priority 1: a user-CONFIRMED intent is authoritative — return it verbatim (confidence
  // "confirmed"), never re-inferring over the top of what the user explicitly set.
  const confirmed = storedConfirmedIntent(profile);
  if (confirmed) return confirmed;
  const rawText = input.rawText ?? "";
  const candidate = input.candidate ?? buildCandidateProfile(profile.id, facts, profile);

  // --- titles: separate history from target, following the priority order ---
  const pastTitles = dedupe(candidate.jobTitles);
  const explicitPrefTitles = dedupe(profile.preferences.targetRoles ?? []);
  const dynamicTitles = dedupe(targetRolesFromProfile(profile));
  const summaryTitles = dedupe(aspirationalTitles(facts, rawText));

  let targetTitles: string[];
  let confidence: IntentConfidence;
  if (explicitPrefTitles.length) {
    targetTitles = explicitPrefTitles;
    confidence = intentIsConfirmed(profile) ? "confirmed" : "inferred_high";
  } else if (dynamicTitles.length) {
    targetTitles = dynamicTitles;
    confidence = intentIsConfirmed(profile) ? "confirmed" : "inferred_high";
  } else if (summaryTitles.length) {
    targetTitles = summaryTitles;
    confidence = "inferred_low";
  } else if (pastTitles.length) {
    targetTitles = pastTitles.slice(0, 3);
    confidence = "inferred_low";
  } else {
    targetTitles = [];
    confidence = "missing";
  }
  targetTitles = targetTitles.slice(0, 7);

  // --- role families from the TARGET (fallback to history when target is empty) ---
  const familySource = targetTitles.length ? targetTitles : pastTitles;
  const roleFamiliesSet = new Set<string>();
  for (const t of familySource) for (const f of roleFamilies(t)) roleFamiliesSet.add(f);
  // Skills-driven families catch domains the titles miss (e.g. SQL/Tableau → data).
  for (const f of roleFamilies("", candidate.hardSkills.map((s) => s.name).join(" "))) roleFamiliesSet.add(f);

  // --- seniority band (±1 rung around the résumé-evidenced level) ---
  const centerRung = rungForLevel(candidate.likelySeniorityLevel);
  const ci = rungIndex(centerRung);
  const seniority = {
    min: clampRung(ci - 1),
    max: clampRung(ci + 1),
    evidence: dedupe([
      candidate.totalYearsExperience > 0 ? `~${candidate.totalYearsExperience}y total experience` : "",
      pastTitles[0] ? `most recent title: ${pastTitles[0]}` : "",
      `résumé reads ${candidate.likelySeniorityBand}`,
    ]),
  };

  // --- skills ---
  const strong = candidate.hardSkills.filter((s) => s.strength === "strong").map((s) => s.name);
  const moderate = candidate.hardSkills.filter((s) => s.strength !== "strong").map((s) => s.name);
  const mustHaveSkills = dedupe(strong).slice(0, 10);
  const niceToHaveSkills = dedupe(moderate).slice(0, 10);
  const transferableSkills = dedupe(candidate.softSkills).slice(0, 8);

  // --- industries ---
  const industries = dedupe([
    ...(profile.preferences.targetIndustries ?? []),
    ...candidate.industries,
    ...detectIndustries(rawText),
  ]).slice(0, 6);

  // --- credentials: what the résumé demonstrably holds (targets requiring these are in-reach) ---
  const requiredCredentials = dedupe(candidate.certifications).slice(0, 8);

  // --- excluded titles from an explicit "avoid roles" answer ---
  const excludeAns = profile.dynamicAnswers.find((d) => /avoid.*role|exclude.*(role|title)|roles?.*avoid/i.test(d.key))?.answer;
  const excludedTitles = dedupe(Array.isArray(excludeAns) ? excludeAns.filter((v): v is string => typeof v === "string") : []);

  const comp = profile.preferences.compensation;
  const compensation =
    comp.desiredBaseMin || comp.desiredBaseMax
      ? {
          currency: "USD" as const,
          ...(comp.desiredBaseMin ? { min: comp.desiredBaseMin } : {}),
          ...(comp.desiredBaseMax ? { target: comp.desiredBaseMax } : {}),
        }
      : undefined;

  return {
    confirmed: confidence === "confirmed",
    confidence,
    roleFamilies: [...roleFamiliesSet],
    targetTitles,
    adjacentTitles: [], // filled by the query planner from role-family packs
    excludedTitles,
    currentOrPastTitles: pastTitles.slice(0, 8),
    seniority,
    mustHaveSkills,
    niceToHaveSkills,
    transferableSkills,
    requiredCredentials,
    missingCredentialDealbreakers: [],
    industries,
    companyTypes: [],
    locations: dedupe(profile.preferences.desiredLocations ?? []),
    workArrangement: workArrangementFrom(profile),
    ...(compensation ? { compensation } : {}),
    dealbreakers: dedupe(profile.preferences.companiesToAvoid ?? []).map((c) => `avoid: ${c}`),
  };
}

export interface ApplyGate {
  /** True when automation may auto-apply (target confirmed / high-confidence). */
  allowed: boolean;
  /** The resolved intent (reused by callers for the funnel / diagnostics). */
  intent: JobSearchIntent;
  /** Plain-language reason from the domain layer, consistent across every apply path. */
  reason: string;
}

/**
 * THE single Part-H apply gate. Every automated apply entry point (automation-cycle, autopilot, and
 * any future one) must consult this instead of re-deriving `intentPermissions(...).canApply` inline —
 * so the safety-critical "may we auto-apply?" decision can never drift between paths. Confidence
 * derives from the profile's target, so `facts` may be empty when a caller doesn't have them loaded.
 */
export function resolveApplyGate(profile: ApplicantProfile, facts: Fact[] = []): ApplyGate {
  const intent = resolveJobSearchIntent({ profile, facts });
  const perms = intentPermissions(intent.confidence);
  return { allowed: perms.canApply, intent, reason: perms.reason };
}

export interface SearchRolesResult {
  roles: string[];
  intent: JobSearchIntent;
}

/**
 * The ordered role strings to fan discovery across — the canonical replacement for the old
 * "top-2 inferred roles" fan-out. The user's own targets come FIRST, then role-family-pack
 * expansions (exact + adjacent titles), so a compliance analyst also searches "Financial Crimes
 * Investigator"/"BSA Officer" and a software engineer also searches "Full Stack Engineer" — a
 * controlled breadth, not two literal titles. Falls back to inferred roles, then a generic
 * "Analyst", so a blank profile still searches something. Also returns the resolved intent so the
 * caller can gate on confidence / build a funnel report.
 */
export function resolveSearchRoles(
  profile: ApplicantProfile,
  facts: Fact[],
  opts: { rawText?: string } = {}
): SearchRolesResult {
  const intent = resolveJobSearchIntent({ profile, facts, ...(opts.rawText ? { rawText: opts.rawText } : {}) });
  let roles: string[] = [];
  if (intent.targetTitles.length) {
    const packs = selectRoleFamilyPacks(intent.roleFamilies);
    roles = dedupe([
      ...intent.targetTitles,
      ...intent.adjacentTitles,
      ...packs.flatMap((p) => p.exactTitles),
      ...packs.flatMap((p) => p.adjacentTitles),
    ]);
  }
  if (!roles.length) roles = inferTargetRoles(profile, facts);
  if (!roles.length) roles = ["Analyst"];
  return { roles, intent };
}
