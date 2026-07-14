import {
  canonicalSkillKey,
  labelForScore,
  type MatchLabel,
  type ParsedResumeProfile,
  type RemoteType,
  type Track,
} from '../shared';
import { detectCredentialRequirements, roleFamilies } from '../../jobs/taxonomy';
import { extractJobSignals } from './jobSignals';
import { TRACK_WEIGHTS, type ScoreWeights } from './weights';

export const SCORING_MODEL_VERSION = 'scorecard-v2';

/** The job fields the scorer reads (a projection of the jobs row + source). */
export interface ScorableJob {
  title: string;
  company: string;
  descriptionClean: string;
  locationNormalized: string;
  remoteType: RemoteType;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryPeriod: string;
  postedAt: string | null;
  sourceType: string;
}

export interface ScoringPreferences {
  track: Track;
  targetTitles: string[];
  excludedTitles: string[];
  preferredLocations: string[];
  remotePreferences: string[];
  salaryMin: number | null;
  industries: string[];
}

export interface ComponentResult {
  /** 0–1 fit. */
  score: number;
  /** false = no data on one side → weight redistributed, never a punitive zero. */
  informative: boolean;
  why?: string;
  concern?: string;
  /** Requirement/qualification phrases the résumé satisfies (for the §16 listing). */
  met?: string[];
  /** Requirement/qualification phrases the résumé does NOT satisfy — negotiable gaps. */
  missing?: string[];
}

export type ComponentName = keyof ScoreWeights;

/**
 * The requirement/qualification breakdown surfaced to the user: what the résumé
 * meets, what it doesn't (framed as negotiable gaps unless a dealbreaker), the
 * recommended (nice-to-have) coverage, adjacent/transferable strengths, and any
 * hard dealbreakers that capped the score.
 */
export interface RequirementListing {
  requirementsMet: string[];
  requirementsMissing: string[];
  preferredMet: string[];
  preferredMissing: string[];
  transferable: string[];
  dealbreakers: string[];
}

export interface JobScoreV1 {
  overall: number; // 0–100
  label: MatchLabel;
  components: Record<ComponentName, ComponentResult>;
  explanation: { why: string[]; concerns: string[] };
  listing: RequirementListing;
}

/** Cross-cutting context computed once and shared by the relevance-sensitive components. */
interface ScoreContext {
  /** The résumé and the posting share at least one role FAMILY (engineering, finance, …). */
  familyOverlap: boolean;
  /** Human-readable overlapping families, for the "transferable" listing. */
  overlapFamilies: string[];
}

/**
 * §15 scorecard (v2): 10 deterministic components, track-based weights (data,
 * not logic), and neutral-data redistribution — a missing salary reweights the
 * informative components instead of zeroing the job. Requirements are treated as
 * NEGOTIABLE (a coverage band, experience tolerance, and adjacent/transferable
 * credit) rather than pass/fail; only genuine dealbreakers (excluded titles, pay
 * far below the floor, an unmet hard clearance) hard-cap the score. Every score
 * ships with §16 hedged explanations plus a requirements-met/gaps listing; any
 * component moving the needle by ≥10 points is guaranteed a bullet. Never says
 * "qualified", "perfect match", "guaranteed".
 */
export function scoreJob(
  job: ScorableJob,
  profile: ParsedResumeProfile,
  prefs: ScoringPreferences,
): JobScoreV1 {
  const signals = extractJobSignals(job.descriptionClean);
  const ctx = buildContext(job, profile, prefs, signals);

  const components: Record<ComponentName, ComponentResult> = {
    title: titleComponent(job, prefs),
    requiredSkills: requiredSkillsComponent(job, profile, signals, ctx),
    preferredSkills: preferredSkillsComponent(profile, signals),
    experience: experienceComponent(profile, signals),
    industry: industryComponent(job, prefs),
    location: locationComponent(job, prefs),
    salary: salaryComponent(job, prefs),
    educationCertification: educationComponent(profile, signals),
    sourceQuality: sourceQualityComponent(job),
    freshness: freshnessComponent(job),
  };

  const weights = TRACK_WEIGHTS[prefs.track];

  // Redistribute weight from uninformative components proportionally.
  const informativeWeight = (Object.keys(components) as ComponentName[])
    .filter((name) => components[name].informative)
    .reduce((sum, name) => sum + weights[name], 0);

  let overall = 0;
  const contributions = new Map<ComponentName, { earned: number; lost: number }>();
  for (const name of Object.keys(components) as ComponentName[]) {
    const component = components[name];
    if (!component.informative || informativeWeight === 0) {
      contributions.set(name, { earned: 0, lost: 0 });
      continue;
    }
    const normalizedWeight = weights[name] / informativeWeight;
    overall += normalizedWeight * component.score * 100;
    contributions.set(name, {
      earned: normalizedWeight * component.score * 100,
      lost: normalizedWeight * (1 - component.score) * 100,
    });
  }
  overall = Math.round(Math.min(100, Math.max(0, overall)));

  const dealbreakers: string[] = [];

  // Relevance gate: when BOTH core relevance signals (title and required skills)
  // are near zero AND the résumé shares no role family with the posting, the job
  // is off-profile — peripheral fit (right city, right pay, fresh posting) must
  // not float an accountant posting into a forklift operator's "possible" band.
  // A shared family (adjacent/transferable) is spared the gate.
  const offProfile =
    !ctx.familyOverlap &&
    components.title.informative &&
    components.requiredSkills.informative &&
    components.title.score < 0.15 &&
    components.requiredSkills.score < 0.2;
  if (offProfile) {
    overall = Math.min(overall, 34);
  }

  // Experience-stretch ceiling: being under the posting's stated minimum years
  // drops the match a band regardless of skill fit (owner-calibrated). Not a
  // dealbreaker — it's surfaced as a negotiable gap in the listing.
  if (
    components.experience.informative &&
    signals.minYears !== null &&
    profile.yearsExperience !== null
  ) {
    const gap = signals.minYears - profile.yearsExperience;
    if (gap > 0) overall = Math.min(overall, experienceStretchCap(gap));
  }

  // Stated salary floor: a job paying >15% under the user's minimum never ranks
  // above the "possible" band, however good the rest looks (§20 — the floor is
  // the user's, not ours to override). This is a user dealbreaker, not a gap.
  if (components.salary.informative && components.salary.score <= 0.15) {
    overall = Math.min(overall, 65);
    dealbreakers.push('The listed pay is well below your stated minimum.');
  }

  // Hard clearance gate: a posting that REQUIRES an active security clearance the
  // résumé shows no sign of is a real barrier — cap to the "possible" band and
  // flag it, rather than hiding it entirely (clearances can be sponsored).
  const creds = detectCredentialRequirements(job.descriptionClean);
  if (creds.requiresSecurityClearance && !resumeHasClearance(profile)) {
    overall = Math.min(overall, 59);
    dealbreakers.push('The posting requires an active security clearance you do not list.');
  }

  // Excluded titles are a user dealbreaker: cap hard, explain honestly.
  const excludedHit = prefs.excludedTitles.find((excluded) =>
    job.title.toLowerCase().includes(excluded.toLowerCase().trim()),
  );
  if (excludedHit) {
    overall = Math.min(overall, 15);
    dealbreakers.unshift(`The title matches “${excludedHit}”, which you excluded.`);
  }

  const explanation = buildExplanation(components, contributions, excludedHit);
  const listing = buildListing(components, ctx, dealbreakers);
  return { overall, label: labelForScore(overall), components, explanation, listing };
}

/** Role-family overlap between the résumé and the posting drives transferable credit + the gate. */
function buildContext(
  job: ScorableJob,
  profile: ParsedResumeProfile,
  prefs: ScoringPreferences,
  signals: ReturnType<typeof extractJobSignals>,
): ScoreContext {
  const jobFamilies = roleFamilies(job.title, signals.requiredSkills.join(' '));
  const resumeFamilies = roleFamilies(
    [...profile.jobTitles, ...prefs.targetTitles].join(' '),
    [...profile.skills, ...profile.tools].join(' '),
  );
  const overlap = [...jobFamilies].filter((f) => resumeFamilies.has(f));
  return { familyOverlap: overlap.length > 0, overlapFamilies: overlap };
}

/** Does the résumé show any security-clearance signal? (skills/certs, canonicalized.) */
function resumeHasClearance(profile: ParsedResumeProfile): boolean {
  const hay = [...profile.skills, ...profile.tools, ...profile.certifications]
    .join(' ')
    .toLowerCase();
  return /\b(security clearance|clearance|ts\/sci|top secret|public trust|secret)\b/.test(hay);
}

/** Assemble the requirements-met/gaps listing from the components + dealbreakers. */
function buildListing(
  components: Record<ComponentName, ComponentResult>,
  ctx: ScoreContext,
  dealbreakers: string[],
): RequirementListing {
  const req = components.requiredSkills;
  const exp = components.experience;
  const edu = components.educationCertification;
  const pref = components.preferredSkills;
  return {
    requirementsMet: dedupe([...(req.met ?? []), ...(exp.met ?? []), ...(edu.met ?? [])]),
    requirementsMissing: dedupe([
      ...(req.missing ?? []),
      ...(exp.missing ?? []),
      ...(edu.missing ?? []),
    ]),
    preferredMet: dedupe(pref.met ?? []),
    preferredMissing: dedupe(pref.missing ?? []),
    transferable: ctx.familyOverlap ? ctx.overlapFamilies.map(familyLabel) : [],
    dealbreakers: dedupe(dealbreakers),
  };
}

/** Turn a taxonomy family id into a reader-facing phrase. */
function familyLabel(family: string): string {
  return `Adjacent experience in ${family.replace(/_/g, ' ')}`;
}

// --- explanation (§16) ------------------------------------------------------

function buildExplanation(
  components: Record<ComponentName, ComponentResult>,
  contributions: Map<ComponentName, { earned: number; lost: number }>,
  excludedHit: string | undefined,
): { why: string[]; concerns: string[] } {
  const why: string[] = [];
  const concerns: string[] = [];

  const FALLBACK_WHY: Record<ComponentName, string> = {
    title: 'The title lines up with your targets.',
    requiredSkills: 'Your skills overlap the listed requirements.',
    preferredSkills: 'You cover several of the nice-to-have skills.',
    experience: 'The experience level appears aligned with yours.',
    industry: 'The company matches your industry preferences.',
    location: 'The location works with your preferences.',
    salary: 'The listed pay meets your minimum.',
    educationCertification: 'You appear to have the credentials the posting asks for.',
    sourceQuality: 'This comes straight from the employer’s own job board.',
    freshness: 'The posting is recent.',
  };
  const FALLBACK_CONCERN: Record<ComponentName, string> = {
    title: 'The title is not close to your target titles.',
    requiredSkills: 'Few of the listed requirements appear in your profile.',
    preferredSkills: 'The nice-to-have skills are mostly not in your profile.',
    experience: 'The experience level may not line up with yours.',
    industry: 'The company is outside your preferred industries.',
    location: 'The location may not match your preferences.',
    salary: 'The listed pay may be below your minimum.',
    educationCertification: 'The posting asks for credentials you do not list.',
    sourceQuality: 'This copy comes from an aggregator, not the employer directly.',
    freshness: 'The posting is not recent.',
  };

  for (const name of Object.keys(components) as ComponentName[]) {
    const component = components[name];
    const contribution = contributions.get(name)!;
    // Guarantee: components moving the needle ≥10 points always get a bullet.
    if (component.informative && contribution.earned >= 10) {
      why.push(component.why ?? FALLBACK_WHY[name]);
    } else if (component.informative && contribution.lost >= 10) {
      concerns.push(component.concern ?? FALLBACK_CONCERN[name]);
    } else if (component.why && component.score >= 0.75 && component.informative) {
      why.push(component.why);
    } else if (component.concern) {
      concerns.push(component.concern);
    }
  }

  if (excludedHit) {
    concerns.unshift(`The title matches “${excludedHit}”, which you excluded.`);
  }
  if (why.length === 0) {
    why.push('This appears to be a weak match overall — shown so you can judge for yourself.');
  }
  return { why: dedupe(why).slice(0, 6), concerns: dedupe(concerns).slice(0, 6) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// --- components --------------------------------------------------------------

const SENIORITY_TOKENS =
  /\b(senior|sr\.?|junior|jr\.?|lead|principal|staff|associate|i{1,3}|iv|v)\b/gi;

function normalizeTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(SENIORITY_TOKENS, ' ')
    .replace(/[^a-z0-9+#./ ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function titleComponent(job: ScorableJob, prefs: ScoringPreferences): ComponentResult {
  if (prefs.targetTitles.length === 0) return { score: 0.5, informative: false };
  const jobTokens = new Set(normalizeTitleTokens(job.title));
  if (jobTokens.size === 0) return { score: 0.5, informative: false };
  let best: string | null = null;
  let bestScore = 0;
  for (const target of prefs.targetTitles) {
    const targetTokens = normalizeTitleTokens(target);
    if (targetTokens.length === 0) continue;
    const overlap = targetTokens.filter((t) => jobTokens.has(t)).length;
    const union = new Set([...jobTokens, ...targetTokens]).size;
    const score = 0.7 * (overlap / targetTokens.length) + 0.3 * (overlap / union);
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  const score = Math.min(1, bestScore);
  return {
    score,
    informative: true,
    why:
      score >= 0.75 && best
        ? `The title is close to your target “${best}”.`
        : score >= 0.4 && best
          ? `The title partially overlaps your target “${best}”.`
          : undefined,
    concern: score < 0.4 ? 'The title is not close to any of your target titles.' : undefined,
  };
}

/**
 * Map required-skill coverage (0–1) to a fit score with a NEGOTIABLE band: meeting
 * most of the listed skills lands strong, a solid half lands "possible", and the
 * curve is generous in the middle so a couple of missing (negotiable) skills don't
 * crater an otherwise-aligned candidate. Long requirement lists therefore can't
 * over-penalize the way a raw matched/total ratio does.
 */
function coverageBand(coverage: number): number {
  // Calibrated to the owner's judgment: a full "strong" skills score needs ~85%+
  // of the listed requirements; meeting ~60% reads as a solid "good", not strong.
  if (coverage >= 0.85) return 0.9 + ((coverage - 0.85) / 0.15) * 0.1; // 0.90 → 1.00
  if (coverage >= 0.6) return 0.72 + ((coverage - 0.6) / 0.25) * 0.18; // 0.72 → 0.90
  if (coverage >= 0.3) return 0.45 + ((coverage - 0.3) / 0.3) * 0.27; // 0.45 → 0.72
  return (coverage / 0.3) * 0.45; // 0.00 → 0.45
}

function requiredSkillsComponent(
  job: ScorableJob,
  profile: ParsedResumeProfile,
  signals: ReturnType<typeof extractJobSignals>,
  ctx: ScoreContext,
): ComponentResult {
  const resumeSkills = [...profile.skills, ...profile.tools, ...profile.certifications];
  if (resumeSkills.length === 0) return { score: 0.5, informative: false };
  const resumeKeys = new Set(resumeSkills.map(canonicalSkillKey));

  if (signals.requiredSkills.length >= 2) {
    const met = signals.requiredSkills.filter((s) => resumeKeys.has(canonicalSkillKey(s)));
    const missing = signals.requiredSkills.filter((s) => !resumeKeys.has(canonicalSkillKey(s)));
    const coverage = met.length / signals.requiredSkills.length;
    let score = coverageBand(coverage);

    // Adjacent/transferable credit: when the role shares a family with the résumé
    // (e.g. a Data Engineer for a Software Engineer) but the exact skill list is
    // thin, floor the score up — related experience is negotiable, not a zero.
    if (ctx.familyOverlap && score < 0.6) score = Math.min(0.72, score + 0.15);

    // Without an explicit "Requirements" heading these skills were only MENTIONED,
    // not stated as hard requirements — treat as a soft positive signal and don't
    // list absent ones as "missing requirements" (§3: don't invent requirements).
    const soft = !signals.hasExplicitSections;
    if (soft) score = Math.max(score, met.length > 0 ? Math.min(1, 0.55 + 0.1 * met.length) : score);
    score = Math.min(1, score);

    const shown = met.slice(0, 4).join(', ');
    return {
      score,
      informative: true,
      met: soft ? [] : met,
      missing: soft ? [] : missing,
      why:
        met.length > 0
          ? `Your profile covers ${met.length} of the ${signals.requiredSkills.length} listed requirements (${shown}${met.length > 4 ? ', …' : ''}).`
          : undefined,
      concern:
        !soft && coverage < 0.5
          ? `You show ${met.length} of the ${signals.requiredSkills.length} listed requirements${missing.length ? ` — ${missing.slice(0, 3).join(', ')} not evident` : ''} (often negotiable).`
          : undefined,
    };
  }

  // Posting names no dictionary skills — fall back to how many of YOUR skills
  // its text mentions (softer signal, same as v0).
  const haystack = ` ${job.descriptionClean.toLowerCase()} `;
  const matched = resumeSkills.filter((skill) => {
    const needle = skill.toLowerCase().trim();
    if (needle.length < 2) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
  });
  let score = Math.min(1, matched.length / 6);
  if (ctx.familyOverlap && score < 0.6) score = Math.min(0.72, score + 0.15);
  return {
    score,
    informative: true,
    why:
      matched.length > 0
        ? `The description mentions ${matched.length} of your skills (${matched.slice(0, 4).join(', ')}${matched.length > 4 ? ', …' : ''}).`
        : undefined,
    concern:
      matched.length === 0 && !ctx.familyOverlap
        ? 'None of your listed skills appear in the description.'
        : undefined,
  };
}

function preferredSkillsComponent(
  profile: ParsedResumeProfile,
  signals: ReturnType<typeof extractJobSignals>,
): ComponentResult {
  if (signals.preferredSkills.length === 0 || profile.skills.length === 0) {
    return { score: 0.5, informative: false };
  }
  const resumeKeys = new Set(
    [...profile.skills, ...profile.tools, ...profile.certifications].map(canonicalSkillKey),
  );
  const met = signals.preferredSkills.filter((s) => resumeKeys.has(canonicalSkillKey(s)));
  const missing = signals.preferredSkills.filter((s) => !resumeKeys.has(canonicalSkillKey(s)));
  const score = met.length / signals.preferredSkills.length;
  return {
    score,
    informative: true,
    met,
    missing,
    why:
      met.length > 0
        ? `You also cover ${met.length} of the ${signals.preferredSkills.length} nice-to-have skills.`
        : undefined,
  };
}

/**
 * Years-of-experience fit with NEGOTIABLE tolerance: at or above the bar is full
 * credit; being a year or three short is a near-miss (most postings flex a couple
 * years), and only a large gap drops steeply. Over-qualification is not a penalty
 * (at most a gentle note well beyond the bar).
 */
function experienceTolerance(gap: number): number {
  if (gap <= 1) return 0.9;
  if (gap <= 2) return 0.8;
  if (gap <= 3) return 0.65;
  if (gap <= 5) return 0.45;
  return Math.max(0.15, 0.45 - (gap - 5) * 0.06);
}

/**
 * Overall ceiling when the candidate is SHORT of the posting's stated minimum
 * years (owner-calibrated, negotiable-leaning): being within a year of the ask no
 * longer caps at all (a "3+ yrs" ask with full skills can still read "strong"),
 * and each further year softens by roughly a band — 2–3 under → up to "good",
 * 4–5 under → "possible", a big gap → "weak". `gap` = required − candidate years.
 */
function experienceStretchCap(gap: number): number {
  if (gap <= 1) return 100; // ≤1 year under the ask → no ceiling; skills can reach "strong"
  if (gap <= 3) return 80; // 2–3 years under → up to "good"
  if (gap <= 5) return 66; // 4–5 years under → up to "possible"
  return 52; // well beyond → "weak"
}

function experienceComponent(
  profile: ParsedResumeProfile,
  signals: ReturnType<typeof extractJobSignals>,
): ComponentResult {
  if (signals.minYears === null || profile.yearsExperience === null) {
    return { score: 0.5, informative: false };
  }
  const years = profile.yearsExperience;
  const required = signals.minYears;
  const bar = `${required}+ years of experience`;
  if (years >= required) {
    const over = years - required;
    if (over > 15) {
      return {
        score: 0.9,
        informative: true,
        met: [bar],
        concern: `The posting asks for ${required}+ years — you may be well beyond this level.`,
      };
    }
    return {
      score: 1,
      informative: true,
      met: [bar],
      why: `The posting asks for ${required}+ years of experience; your history appears to cover that.`,
    };
  }
  const gap = required - years;
  const score = experienceTolerance(gap);
  return {
    score,
    informative: true,
    missing: [`${bar} (résumé shows about ${years})`],
    concern:
      gap <= 3
        ? `The posting asks for ${required}+ years; your profile shows about ${years} — usually negotiable.`
        : `The posting asks for ${required}+ years of experience; your profile shows about ${years}.`,
  };
}

function industryComponent(job: ScorableJob, prefs: ScoringPreferences): ComponentResult {
  if (prefs.industries.length === 0) return { score: 0.5, informative: false };
  const haystack = `${job.company} ${job.descriptionClean.slice(0, 1500)}`.toLowerCase();
  // Word-boundary match so short industries ("art", "IT") don't hit inside
  // "start"/"quarterly" and spuriously score a perfect industry fit.
  const matched = prefs.industries.filter((industry) => {
    const needle = industry.toLowerCase().trim();
    if (needle.length < 2) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
  });
  if (matched.length > 0) {
    return {
      score: 1,
      informative: true,
      why: `This looks like a ${matched[0]} role, matching your industry preference.`,
    };
  }
  return { score: 0.35, informative: true };
}

function locationComponent(job: ScorableJob, prefs: ScoringPreferences): ComponentResult {
  const remoteOk = prefs.remotePreferences.includes('remote');
  if (job.remoteType === 'remote') {
    if (remoteOk) {
      return {
        score: 1,
        informative: true,
        why: 'The role is remote, which matches your preferences.',
      };
    }
    // The user never stated a work-mode preference → don't punish a remote role
    // (most candidates would consider it); treat as mildly favorable, not a gap.
    if (prefs.remotePreferences.length === 0) {
      return { score: 0.6, informative: true };
    }
    // The user stated a preference that excludes remote → a soft concern, not a
    // near-zero (still worth surfacing; work mode is often negotiable).
    return {
      score: 0.35,
      informative: true,
      concern: 'The role is remote, which is outside your stated work-mode preference.',
    };
  }
  if (prefs.preferredLocations.length === 0 || !job.locationNormalized) {
    return {
      score: 0.5,
      informative: false,
      concern: !job.locationNormalized ? 'The job does not state a clear location.' : undefined,
    };
  }
  const jobLocation = job.locationNormalized.toLowerCase();
  let sameState = false;
  for (const preferred of prefs.preferredLocations) {
    const tokens = preferred
      .toLowerCase()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const city = tokens[0];
    const state = tokens[tokens.length - 1];
    // A CITY match is a location fit. A bare state match is NOT — "Cincinnati,
    // OH" is a hundred miles from "Columbus, OH" and no commute for an onsite role.
    if (city && city.length >= 3 && jobLocation.includes(city)) {
      return { score: 1, informative: true, why: 'The job is in your preferred location.' };
    }
    if (state && state.length === 2 && jobLocation.endsWith(`, ${state}`)) {
      sameState = true;
    }
  }
  if (sameState) {
    return {
      score: 0.3,
      informative: true,
      concern: 'The job is in your state but not in your preferred city.',
    };
  }
  return {
    score: 0.15,
    informative: true,
    concern: 'The location does not match your preferences.',
  };
}

/** Annualize for comparison only; the stored job keeps its stated period. */
function annualized(amount: number, period: string): number {
  switch (period) {
    case 'hour':
      return amount * 2080;
    case 'day':
      return amount * 260;
    case 'week':
      return amount * 52;
    case 'month':
      return amount * 12;
    default:
      return amount;
  }
}

function salaryComponent(job: ScorableJob, prefs: ScoringPreferences): ComponentResult {
  const jobTop = job.salaryMax ?? job.salaryMin;
  if (jobTop === null) {
    return { score: 0.5, informative: false, concern: 'Salary is not listed.' };
  }
  if (prefs.salaryMin === null) return { score: 0.5, informative: false };
  const jobAnnual = annualized(jobTop, job.salaryPeriod);
  if (jobAnnual >= prefs.salaryMin) {
    return {
      score: 1,
      informative: true,
      why: 'The listed pay meets your minimum.',
    };
  }
  if (jobAnnual >= prefs.salaryMin * 0.85) {
    return {
      score: 0.55,
      informative: true,
      concern: 'The listed pay tops out slightly below your minimum.',
    };
  }
  return {
    score: 0.1,
    informative: true,
    concern: 'The listed pay is below your minimum.',
  };
}

function educationComponent(
  profile: ParsedResumeProfile,
  signals: ReturnType<typeof extractJobSignals>,
): ComponentResult {
  const demandsCerts = signals.requiredCerts.length > 0;
  const demandsDegree = signals.requiredDegree !== null;
  if (!demandsCerts && !demandsDegree) return { score: 0.5, informative: false };

  // Score cert and degree sub-signals independently; each stays non-informative
  // (redistributed, never a punitive zero) when we have no résumé data to judge
  // it — a missing degree we can't see must not crater an otherwise-strong match.
  const sub: number[] = [];
  const met: string[] = [];
  const missing: string[] = [];
  let why: string | undefined;
  let concern: string | undefined;

  if (demandsCerts) {
    const resumeCerts = new Set(profile.certifications.map(canonicalSkillKey));
    const missingCerts = signals.requiredCerts.filter((c) => !resumeCerts.has(canonicalSkillKey(c)));
    if (missingCerts.length === 0) {
      sub.push(1);
      met.push(`${signals.requiredCerts[0]} credential`);
      why = `You appear to hold the credential the posting mentions (${signals.requiredCerts[0]}).`;
    } else {
      // A real gap worth surfacing, but named certs are sometimes waived/pending —
      // a soft ding, not a knockout, and listed as a negotiable gap.
      sub.push(0.4);
      missing.push(`${missingCerts[0]} credential`);
      concern = `The posting asks for ${missingCerts[0]}, which your profile does not list.`;
    }
  }

  if (demandsDegree) {
    if (profile.education.length === 0) {
      // No education data → stay neutral (degree requirements are often flexible
      // and we can't see the résumé's schooling here).
    } else {
      const degrees = profile.education.map((e) => e.degree?.toLowerCase() ?? '').join(' ');
      const rank = { associate: 1, bachelor: 2, master: 3, phd: 4 } as const;
      const has =
        degrees.includes('phd') || degrees.includes('doctor')
          ? 4
          : degrees.includes('master') ||
              degrees.includes('mba') ||
              /\bm\.?s\b/.test(degrees) ||
              /\bm\.?a\b/.test(degrees)
            ? 3
            : degrees.includes('bachelor') || /\bb\.?s\b/.test(degrees) || /\bb\.?a\b/.test(degrees)
              ? 2
              : degrees.includes('associate')
                ? 1
                : 0;
      const label = `${signals.requiredDegree} degree`;
      if (has >= rank[signals.requiredDegree!]) {
        sub.push(1);
        met.push(label);
      } else {
        sub.push(0.55); // degree shortfalls are commonly negotiable
        missing.push(label);
        concern ??= `The posting mentions a ${label}, which your profile does not clearly show.`;
      }
    }
  }

  if (sub.length === 0) return { score: 0.5, informative: false };
  return {
    score: Math.min(...sub),
    informative: true,
    ...(met.length ? { met } : {}),
    ...(missing.length ? { missing } : {}),
    ...(why ? { why } : {}),
    ...(concern ? { concern } : {}),
  };
}

function sourceQualityComponent(job: ScorableJob): ComponentResult {
  switch (job.sourceType) {
    case 'ats_greenhouse':
    case 'ats_lever':
    case 'api_usajobs':
      return { score: 1, informative: true };
    case 'career_page':
      return { score: 0.8, informative: true };
    case 'api_adzuna':
    case 'api_jooble':
      return {
        score: 0.55,
        informative: true,
        concern: 'This copy comes from an aggregator; details may lag the employer’s site.',
      };
    default:
      return { score: 0.5, informative: false };
  }
}

function freshnessComponent(job: ScorableJob): ComponentResult {
  if (!job.postedAt) return { score: 0.5, informative: false };
  const posted = Date.parse(job.postedAt);
  if (Number.isNaN(posted)) return { score: 0.5, informative: false };
  const days = (Date.now() - posted) / 86_400_000;
  if (days <= 7) return { score: 1, informative: true };
  if (days <= 30) return { score: 0.8, informative: true };
  if (days <= 60) {
    return {
      score: 0.5,
      informative: true,
      concern: 'The posting is older than 30 days.',
    };
  }
  return {
    score: 0.2,
    informative: true,
    concern: 'The posting is older than 60 days and may be stale.',
  };
}
