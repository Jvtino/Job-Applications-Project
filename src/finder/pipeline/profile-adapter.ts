// src/finder/pipeline/profile-adapter.ts
//
// Projects ApplyPilot's source-of-truth (ApplicantProfile + resolved
// JobSearchIntent + ResumeInsights) into the finder's scoring inputs
// (ParsedResumeProfile + ScoringPreferences). Pure, no I/O, no new state — the
// caller loads the three inputs and the scorer consumes the two outputs.
//
// The finder's scorer reads only skills/tools/certifications/yearsExperience/
// education from the résumé profile; everything else is left null/empty and
// reweighted as non-informative (never a punitive zero).

import {
  CERTIFICATION_DICTIONARY,
  dedupeByCanonicalSkill,
  dictionaryMatches,
  SKILL_DICTIONARY,
  type ParsedResumeProfile,
  type Track,
} from "../shared";
import type { ScoringPreferences } from "../scoring/scoreJob";
import type { Answer, ApplicantProfile } from "../../types/applicant-profile";
import type { JobSearchIntent } from "../../types/job-search-intent";
import type { ResumeInsights } from "../../types/resume-insights";

export interface FinderInputs {
  profile: ParsedResumeProfile;
  prefs: ScoringPreferences;
}

/** Unwrap an ApplicantProfile Answer<T>; treat decline/null as "no answer". */
function answerValue<T>(a: Answer<T> | undefined | null): T | null {
  const v = a?.value;
  if (v == null || v === "decline_to_answer") return null;
  return v as T;
}

/** Trim, drop empties, dedupe (case-sensitively) across several string sources. */
function uniqNonEmpty(...lists: Array<Iterable<string> | undefined | null>): string[] {
  const out = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const s of list) {
      const t = (s ?? "").trim();
      if (t) out.add(t);
    }
  }
  return [...out];
}

/**
 * Map ApplyPilot's role families / résumé domains / target titles to one of the
 * finder's 10 scoring tracks (the track only selects a weight table). Domain
 * wins first; entry-level is a fallback for thin/junior profiles with no domain
 * signal; general_professional is the safe default.
 */
const TRACK_KEYWORDS: ReadonlyArray<readonly [Track, RegExp]> = [
  ["finance_compliance", /financ|complian|account|audit|\brisk\b|aml|kyc|bsa|sanction|regulator|\btax\b|bookkeep|treasur|underwrit/],
  ["tech", /engineer|developer|software|programmer|devops|\bdata\b|\bit\b|information technology|cybersecurit|\bcloud\b|\bqa\b|\bsre\b|machine learning|\bai\b/],
  ["healthcare_admin", /health|clinic|nurse|medical|patient|\bcare\b|pharma|physician|therap|hospital|revenue cycle/],
  ["government", /government|federal|public sector|municipal|civil service|\bpolicy\b|clearance|\bgs-\d/],
  ["sales", /\bsales\b|account executive|business development|\bquota\b|account manager|\bsdr\b|\bbdr\b/],
  ["customer_support", /support|customer success|help desk|service desk|call center|client service|\bcsr\b/],
  ["office_admin", /administrative|\boffice\b|executive assistant|receptionist|\bclerk\b|coordinator|data entry|scheduling/],
  ["blue_collar_hourly", /warehouse|driver|logistics|retail|hourly|\blabor\b|technician|\btrades\b|electrician|plumb|machinist|forklift|maintenance|manufactur|assembl|janitor|custodian/],
];

function mapTrack(
  intent: JobSearchIntent | null,
  insights: ResumeInsights | null,
  targetTitles: string[],
): Track {
  const hay = [
    ...(intent?.roleFamilies ?? []),
    ...(insights?.domains ?? []),
    ...targetTitles,
    ...(intent?.currentOrPastTitles ?? []),
  ]
    .join(" ")
    .toLowerCase();
  for (const [track, re] of TRACK_KEYWORDS) {
    if (re.test(hay)) return track;
  }
  if ((insights?.seniorityLevel ?? 99) <= 1 && hay.trim().length > 0) return "entry_level";
  return "general_professional";
}

/** ApplyPilot work arrangement -> finder remote preference tokens. */
function mapRemotePreferences(
  intent: JobSearchIntent | null,
  profile: ApplicantProfile,
): string[] {
  if (intent?.workArrangement?.length) {
    return uniqNonEmpty(
      intent.workArrangement.map((w) => (w === "remote_us" ? "remote" : w)),
    );
  }
  const wm = answerValue(profile.preferences.workModePreference);
  return Array.isArray(wm) ? uniqNonEmpty(wm) : [];
}

/**
 * Build the finder's scoring inputs from ApplyPilot's profile + intent +
 * résumé insights. `intent`/`insights` may be null (not yet resolved) — the
 * mapping falls back to `ApplicantProfile.preferences` and degrades gracefully.
 */
export function buildFinderInputs(input: {
  profile: ApplicantProfile;
  intent: JobSearchIntent | null;
  insights: ResumeInsights | null;
}): FinderInputs {
  const { profile, intent, insights } = input;
  const prefsIn = profile.preferences;

  const targetTitles = uniqNonEmpty(
    intent?.targetTitles,
    intent?.adjacentTitles,
    prefsIn.targetRoles,
  );
  const industries = uniqNonEmpty(intent?.industries, prefsIn.targetIndustries);
  const salaryMin =
    intent?.compensation?.min ?? prefsIn.compensation.desiredBaseMin ?? null;

  const prefs: ScoringPreferences = {
    track: mapTrack(intent, insights, targetTitles),
    targetTitles,
    excludedTitles: uniqNonEmpty(intent?.excludedTitles),
    preferredLocations: uniqNonEmpty(intent?.locations, prefsIn.desiredLocations),
    remotePreferences: mapRemotePreferences(intent, profile),
    salaryMin,
    industries,
  };

  // Free-text résumé skill signal (insights + intent). The JOB side canonicalizes
  // its required skills to SKILL_DICTIONARY spellings, so we ALSO run the résumé
  // text through the same dictionary — both sides then speak one vocabulary and
  // the scorer's canonicalSkillKey reconciles the rest ("JS"↔"JavaScript").
  const resumeSkillStrings = uniqNonEmpty(
    insights?.skills?.map((s) => s.name),
    intent?.mustHaveSkills,
    intent?.niceToHaveSkills,
    intent?.transferableSkills,
  );
  const resumeText = resumeSkillStrings.join(" \n ");
  const skills = dedupeByCanonicalSkill([
    ...resumeSkillStrings,
    ...dictionaryMatches(resumeText, SKILL_DICTIONARY),
  ]);
  // Credentials the candidate lists among their own skills (CAMS, PMP, RN, …).
  // Only what the résumé itself surfaces — never the search's required creds.
  const certifications = dedupeByCanonicalSkill(
    dictionaryMatches(resumeText, CERTIFICATION_DICTIONARY),
  );

  const parsedProfile: ParsedResumeProfile = {
    name: null,
    location: null,
    email: null,
    phone: null,
    summary: null,
    workHistory: [],
    jobTitles: uniqNonEmpty(insights?.topTitles, intent?.currentOrPastTitles),
    companies: [],
    skills,
    tools: [],
    certifications,
    // Résumé schooling from insights, so a posting's degree requirement is scored
    // (credit the candidate's degree) instead of always non-informative.
    education: (insights?.education ?? []).map((e) => ({
      degree: e.degree,
      institution: e.institution,
      year: e.year,
    })),
    industries,
    yearsExperience: insights?.totalYearsExperience ?? prefsIn.yearsOfExperience ?? null,
    achievements: [],
    languages: [],
    workAuthorizationStatus: null,
  };

  return { profile: parsedProfile, prefs };
}
