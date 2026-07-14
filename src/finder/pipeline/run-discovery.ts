// src/finder/pipeline/run-discovery.ts
//
// The finder discovery pass: fetch every enabled source through NetGuard
// (reads-only, host-allowlisted), normalize, drop confidently non-US postings,
// dedupe across sources by canonical URL, score against the adapted profile,
// and upsert into ApplyPilot's discovered_jobs. Returns a DiscoveryRun the API
// and apply orchestrator already understand. DB-free connectors; the only
// persistence is DiscoveredJobsRepo.upsert.

import { randomUUID } from "node:crypto";
import type { DB } from "../../db/database";
import { CompaniesRepo } from "../../db/companies-repo";
import { DiscoveredJobsRepo } from "../../db/discovered-jobs-repo";
import type { AtsType, ScoredPosting, TargetCompany } from "../../jobs/types";
import type { ApplicantProfile } from "../../types/applicant-profile";
import type { JobSearchIntent } from "../../types/job-search-intent";
import type { ResumeInsights } from "../../types/resume-insights";
import { NetGuard } from "../net";
import type { ConnectorContext } from "../sources/connector";
import { connectorFor } from "../sources/registry";
import { isNonUsLocation, normalizeCompany, normalizeJob } from "../normalization";
import { JobCollector } from "../dedupe";
import { scoreJob, type JobScoreV1, type ScorableJob } from "../scoring/scoreJob";
import {
  actionForCategory,
  type CategoryScores,
  type JobFitScore,
  type MatchCategory,
} from "../../types/job-fit";
import type { NormalizedJob, SourceType } from "../shared";
import { buildFinderInputs } from "./profile-adapter";
import { companySources, keywordSources } from "./company-sources";
import { readAlertMail } from "../../email/alert-parser";
import { buildCompanyBoardIndex, loadCuratedBoards } from "../../jobs/company-board-catalog";
import { collectAlertedCompanies, resolveAlertBoards } from "./alert-board-resolution";
import type { CompanyDiscovery, DiscoveryRun } from "./discovery-run-types";

const FINDER_TO_ATS: Record<string, AtsType> = {
  ats_greenhouse: "greenhouse",
  ats_lever: "lever",
  ats_ashby: "ashby",
  ats_smartrecruiters: "smartrecruiters",
  ats_workable: "workable",
  ats_workday: "workday",
  api_usajobs: "usajobs",
  api_adzuna: "adzuna",
  assisted_linkedin: "linkedin",
  assisted_indeed: "indeed",
};

export interface RunFinderOptions {
  db: DB;
  profile: ApplicantProfile;
  intent: JobSearchIntent | null;
  insights: ResumeInsights | null;
  getSecret?: (key: string) => string | null;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
  /** Injectable NetGuard (tests pass one backed by a MockAgent). Defaults to a real reads-only guard. */
  net?: NetGuard;
  /**
   * Folder of exported LinkedIn/Indeed job-alert emails (.eml/.mbox) to fold into discovery. Falls
   * back to APPLYPILOT_ALERT_MAIL_DIR. Unset/missing -> email ingestion is simply skipped.
   */
  alertMailDir?: string;
  /**
   * Curated employer-board catalog files used to resolve alerted companies → their ATS boards.
   * Defaults to config/targets*.json; tests override it. Never changes what hosts can be contacted.
   */
  curatedBoardPaths?: string[];
}

function scorableFrom(job: NormalizedJob, sourceType: SourceType): ScorableJob {
  return {
    title: job.title,
    company: job.company,
    descriptionClean: job.descriptionClean,
    locationNormalized: job.locationNormalized,
    remoteType: job.remoteType,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    salaryPeriod: job.salaryPeriod,
    postedAt: job.postedAt,
    sourceType,
  };
}

function toScoredPosting(
  job: NormalizedJob,
  sourceType: SourceType,
  result: JobScoreV1,
): ScoredPosting {
  const c = result.components;
  const pct = (x: number) => Math.round(x * 100);
  const annual = job.salaryPeriod === "year";
  return {
    title: job.title,
    company: job.company,
    location: job.locationNormalized || undefined,
    jobUrl: job.canonicalUrl ?? job.applyUrl,
    atsType: FINDER_TO_ATS[sourceType] ?? "unknown",
    score: result.overall / 100,
    rationale: result.explanation.why.join(" "),
    knockouts: [],
    salaryMin: annual && job.salaryMin != null ? job.salaryMin : undefined,
    salaryMax: annual && job.salaryMax != null ? job.salaryMax : undefined,
    description: job.descriptionClean ? job.descriptionClean.slice(0, 4000) : undefined,
    fitFactors: {
      skills: pct((c.requiredSkills.score + c.preferredSkills.score) / 2),
      salary: pct(c.salary.score),
      location: pct(c.location.score),
      seniority: pct(c.experience.score),
      culture: pct(c.industry.score),
    },
    tags: [result.label],
    fit: toJobFit(result),
  };
}

/**
 * Map the scorecard-v2 result into the JobFitScore shape the DB/API/UI already
 * carry — so the requirements-met/gaps listing surfaces without new plumbing.
 *
 * Apply/display behavior is deliberately preserved:
 *  - matchCategory NEVER maps to weak/reject above the 0.35 display floor, so the
 *    review list still shows everything the score floor would (a low score hides a
 *    job from RECOMMENDATIONS, never from REVIEW).
 *  - hardBlockers stays empty; soft dealbreakers (salary/clearance) already cap the
 *    score and stay visible for review — they surface in the listing, not as a hide.
 *  - apply-recommendation still hinges on the 0.75 score floor in
 *    isActionableDiscoveredJob; matchCategory only gates as a secondary "strong/good".
 *
 * The reject threshold is pinned to the 0.35 display floor and we never emit the
 * "weak" category — both "weak" and "reject" are hidden from the review list, so a
 * job at/above the display floor must map to stretch/good/strong to stay visible.
 */
export function fitCategoryFor(overall: number): MatchCategory {
  if (overall >= 85) return "strong";
  if (overall >= 75) return "good";
  if (overall >= 35) return "stretch"; // 0.35 == DISPLAY_MIN_SCORE: shown for review
  return "reject"; // below the display floor anyway
}

/** Public for apply-readiness lock-in tests: map a scorecard result to the fit shape. */
export function jobFitFromScore(result: JobScoreV1): JobFitScore {
  return toJobFit(result);
}

function toJobFit(result: JobScoreV1): JobFitScore {
  const c = result.components;
  const pct = (x: number) => Math.round(x * 100);
  const matchCategory = fitCategoryFor(result.overall);
  const L = result.listing;
  const categoryScores: CategoryScores = {
    titleAlignment: pct(c.title.score),
    hardSkillMatch: pct(c.requiredSkills.score),
    experienceMatch: pct(c.experience.score),
    industryMatch: pct(c.industry.score),
    seniorityMatch: pct(c.experience.score),
    locationWorkArrangement: pct(c.location.score),
    educationCertificationMatch: pct(c.educationCertification.score),
    resumeStrengthForRole: pct(c.preferredSkills.score),
    interviewProbability: result.overall,
  };
  const topMatchReasons = dedupeStrings([
    ...L.requirementsMet,
    ...L.transferable,
    ...L.preferredMet.map((s) => `${s} (nice-to-have)`),
    ...result.explanation.why,
  ]).slice(0, 8);
  return {
    overallScore: result.overall,
    matchCategory,
    interviewProbability:
      matchCategory === "strong" ? "high" : matchCategory === "good" ? "medium" : "low",
    categoryScores,
    categoryReasoning: {},
    reasoningSummary: result.explanation.why.join(" "),
    topMatchReasons,
    mainConcerns: result.explanation.concerns,
    missingRequirements: L.requirementsMissing,
    recommendedAction: actionForCategory(matchCategory),
    resumeKeywordsToEmphasize: L.requirementsMet.slice(0, 8),
    coverLetterAngle: "",
    // Kept empty on purpose: soft dealbreakers stay visible for review (they cap the
    // score instead). Surfaced to the user via requirementListing.dealbreakers.
    hardBlockers: [],
    confidence: "medium",
    method: "deterministic",
    requirementListing: L,
  };
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.filter((s) => s && s.trim().length > 0))];
}

/** One finder discovery pass. Writes scored postings into discovered_jobs. */
export async function runFinderDiscovery(opts: RunFinderOptions): Promise<DiscoveryRun> {
  const { db, profile } = opts;
  const traceId = randomUUID();
  const { profile: parsedProfile, prefs } = buildFinderInputs({
    profile,
    intent: opts.intent,
    insights: opts.insights,
  });

  const net = opts.net ?? new NetGuard();
  const ctx: ConnectorContext = {
    net,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.getSecret ? { getSecret: opts.getSecret } : {}),
  };

  const companies = new CompaniesRepo(db).list({ enabledOnly: true });

  // Read exported LinkedIn/Indeed job-alert emails ONCE, up front (metadata + links only; no login).
  const mailDir = opts.alertMailDir ?? process.env.APPLYPILOT_ALERT_MAIL_DIR?.trim();
  const alerts = mailDir && !opts.signal?.aborted ? readAlertMail(mailDir) : [];

  // Resolve the employers named in those alert leads to their OWN ATS boards, so we scan the real
  // off-platform posting instead of the LinkedIn/Indeed link. Catalog-first + a bounded, allowlisted-
  // only ATS probe; compliance is enforced at the resolver (fixed vendor/host tables) AND NetGuard
  // (linkedin/indeed/glassdoor hard-denied before any allowlist). Set APPLYPILOT_DISABLE_BOARD_PROBE=1
  // to restrict resolution to the curated catalog (no probing). Scanning the resolved board lets the
  // shared collector below collapse the alert lead into the direct-ATS posting.
  const probeAllowed = process.env.APPLYPILOT_DISABLE_BOARD_PROBE !== "1";
  const knownNames = new Set(companies.map((c) => normalizeCompany(c.name)));
  const resolvedBoards = alerts.length
    ? await resolveAlertBoards(collectAlertedCompanies(alerts), {
        index: buildCompanyBoardIndex(loadCuratedBoards(opts.curatedBoardPaths)),
        known: knownNames,
        ...(probeAllowed ? { net } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    : [];
  const nowIso = new Date().toISOString();
  const resolvedCompanies: TargetCompany[] = resolvedBoards.map((b, i) => ({
    id: `alert-resolved:${i}`,
    name: b.name,
    boardUrl: b.boardUrl,
    atsType: b.atsType,
    enabled: true,
    autoSubmitApproved: false,
    createdAt: nowIso,
  }));

  const sources = [
    ...companySources(companies),
    ...companySources(resolvedCompanies), // employer boards resolved from alert leads
    ...keywordSources(prefs, opts.getSecret),
  ];

  // Fetch → normalize → US-filter → dedupe across sources via the identity cascade. An employer ATS
  // posting and a LinkedIn/Indeed alert-email lead for the same role collapse to one record; the
  // higher-priority source (direct ATS beats an email lead) wins the kept representation.
  const perSource = new Map<string, { found: number; errors: string[] }>();
  const collector = new JobCollector();
  for (const source of sources) {
    if (opts.signal?.aborted) break;
    const connector = connectorFor(source.sourceType);
    if (!connector) continue;
    opts.onProgress?.(`Searching ${source.sourceName}…`);
    const bucket = perSource.get(source.sourceName) ?? { found: 0, errors: [] };
    try {
      const raws = await connector.fetchJobs(source, ctx);
      bucket.found += raws.length;
      for (const raw of raws) {
        const job = normalizeJob(raw);
        if (isNonUsLocation(job.locationRaw, job.locationNormalized)) continue;
        collector.add(job, {
          sourceType: source.sourceType,
          sourceId: source.slug,
          sourceName: source.sourceName,
        });
      }
    } catch (err) {
      bucket.errors.push(err instanceof Error ? err.message : String(err));
    }
    perSource.set(source.sourceName, bucket);
  }

  // Fold in the LinkedIn/Indeed job-alert leads (read up front; metadata + links only, no Gmail
  // login). They normalize and dedupe through the SAME collector as the ATS feeds, so an emailed
  // lead and the employer's own ATS posting for one role collapse to a single record — and because
  // we resolved+scanned the employer's board above, the direct-ATS representation (higher priority)
  // wins, surfacing the real off-platform posting in place of the LinkedIn/Indeed link.
  for (const { raw, sourceType } of alerts) {
    if (opts.signal?.aborted) break;
    const sourceName = sourceType === "assisted_indeed" ? "Indeed alerts" : "LinkedIn alerts";
    const bucket = perSource.get(sourceName) ?? { found: 0, errors: [] };
    bucket.found += 1;
    perSource.set(sourceName, bucket);
    const job = normalizeJob(raw);
    if (isNonUsLocation(job.locationRaw, job.locationNormalized)) continue;
    collector.add(job, { sourceType, sourceId: sourceType, sourceName });
  }

  // Score + upsert.
  const jobsRepo = new DiscoveredJobsRepo(db);
  const scored: ScoredPosting[] = [];
  const newlyAdded: ScoredPosting[] = [];
  const rescoredExisting: ScoredPosting[] = [];
  const addedBySource = new Map<string, number>();

  for (const { job, sourceType, sourceName } of collector.values()) {
    if (opts.signal?.aborted) break;
    const st = sourceType as SourceType;
    const result = scoreJob(scorableFrom(job, st), parsedProfile, prefs);
    const posting = toScoredPosting(job, st, result);
    const { isNew } = jobsRepo.upsert(profile.id, posting, "scored");
    scored.push(posting);
    if (isNew) {
      newlyAdded.push(posting);
      addedBySource.set(sourceName, (addedBySource.get(sourceName) ?? 0) + 1);
    } else {
      rescoredExisting.push(posting);
    }
  }

  const perCompany: CompanyDiscovery[] = [...perSource.entries()].map(([company, s]) => ({
    company,
    found: s.found,
    added: addedBySource.get(company) ?? 0,
    errors: s.errors,
    viaApi: true,
  }));

  return {
    traceId,
    perCompany,
    scored,
    newlyAdded,
    rescoredExisting,
    scoredVisible: scored,
    targetsAdded: resolvedBoards.map((b) => b.name),
    targetsResolvedOpen: 0,
  };
}
