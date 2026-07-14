// src/orchestrator/prepare-docs.ts
//
// Generate tailored, verifier-gated résumé + cover letter PDFs for a discovered job before
// opening the application form. Falls back to the master résumé when generation isn't possible.

import { dirname, join } from "node:path";
import type { DB } from "../db/database";
import { LedgerRepo } from "../db/ledger-repo";
import type { ApplicantProfile } from "../types/applicant-profile";
import { parsePosting } from "../generation/posting";
import { generateApplicationDocuments } from "../generation/pipeline";
import { saveGeneratedDocs } from "../generation/render";
import type { LedgerCheckResult } from "../generation/ledger-check";
import { aiEnabled } from "../llm/capabilities";

export interface JobForDocs {
  company: string;
  title: string;
  location?: string;
  rationale?: string;
  jobUrl?: string;
  /** Full job-description text from discovery, when available — the real keyword/requirement source. */
  description?: string;
}

export interface PreparedDocs {
  resumePath: string;
  coverLetterPath?: string;
  ledgerCheck?: LedgerCheckResult;
  allEligible: boolean;
  generator: "tailored" | "master";
}

/** Thrown when documents cannot be attached to a live application (failed ledger / no approved facts). */
export class DocsBlockedError extends Error {
  constructor(
    message: string,
    /** The failed ledger check, when generation ran but a claim was unsupported. */
    readonly ledgerCheck?: LedgerCheckResult
  ) {
    super(message);
    this.name = "DocsBlockedError";
  }
}

export interface PrepareDocsOptions {
  useLlm?: boolean;
  /**
   * PREVIEW-ONLY mode. When true, this call is for on-screen review / manual download — NOT for
   * attaching to a live employer form. In this mode:
   *   - the master résumé fallback is allowed when there are no approved facts;
   *   - a failed ledger check is RETURNED (allEligible=false) instead of throwing, so the UI can
   *     surface the offending claims.
   * When false/omitted (the automated/apply path), neither the master fallback nor a failed ledger
   * check may proceed — the call throws DocsBlockedError. This is the hard anti-fabrication gate:
   * ApplyPilot never attaches an unverified résumé/cover letter to a real application.
   */
  previewOnly?: boolean;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
}

/** Build the posting text generation tailors toward — the real JD when present, else a stub. Exported for tests. */
export function postingTextFor(job: JobForDocs): string {
  const header = [
    `${job.title}`,
    `Company: ${job.company}`,
    job.location ? `Location: ${job.location}` : "",
  ].filter(Boolean);
  // Prefer the REAL job description: it carries the exact keywords/requirements that drive fact
  // ranking and the ATS-gap report. Fall back to the rationale + a generic stub only when discovery
  // captured no description. A few words of description isn't enough to parse, so guard on length.
  const body =
    job.description && job.description.trim().length >= 40
      ? job.description.trim()
      : [
          job.rationale ?? "",
          "We are hiring for this role. Responsibilities include relevant experience from your background.",
        ]
          .filter(Boolean)
          .join("\n");
  return [...header, "", body].join("\n");
}

function combineChecks(a: LedgerCheckResult, b: LedgerCheckResult): LedgerCheckResult {
  const checks = [...a.checks, ...b.checks];
  return { passed: a.passed && b.passed, checks };
}

/** Default generated-docs directory alongside the SQLite datastore. */
export function defaultGeneratedDir(dbPath: string): string {
  return join(dirname(dbPath), "generated");
}

/**
 * Tailor documents for a job, or fall back to the profile's master résumé.
 * Throws when neither tailored generation nor a master résumé is available.
 */
export async function prepareApplicationDocs(
  db: DB,
  encryptionKey: Buffer | undefined,
  generatedDir: string,
  profile: ApplicantProfile,
  job: JobForDocs,
  opts: PrepareDocsOptions = {}
): Promise<PreparedDocs> {
  const previewOnly = opts.previewOnly ?? false;
  const ledger = new LedgerRepo(db, encryptionKey).get(profile.id);
  const hasApproved = ledger?.facts.some((f) => f.approved) ?? false;

  if (!hasApproved || !ledger) {
    // A3: the master résumé is a RAW file that never passed the anti-fabrication verifier. It may
    // only be surfaced for manual preview/download — NEVER auto-attached to a live application.
    if (previewOnly && profile.masterResumePath) {
      return { resumePath: profile.masterResumePath, allEligible: false, generator: "master" };
    }
    throw new DocsBlockedError(
      "Approve résumé facts in the ledger before automation can attach documents. " +
        "Upload a résumé, approve facts in Résumé, then try again."
    );
  }

  const posting = parsePosting(postingTextFor(job), {
    title: job.title,
    company: job.company,
    ...(job.location ? { location: job.location } : {}),
    ...(job.jobUrl ? { applyUrl: job.jobUrl } : {}),
  });

  // Explicit false still forces the template generator; otherwise LLM documents ride the
  // capability resolver (they were previously dark in every app path — commercial M3).
  const useLlm = opts.useLlm ?? aiEnabled("doc-generation");
  const result = await generateApplicationDocuments(ledger, profile, posting, { useLlm });
  const slug = slugify(`${job.company}-${job.title}`);
  const saved = await saveGeneratedDocs(result.resume.model, result.coverLetter.model, generatedDir, slug);
  const ledgerCheck = combineChecks(result.resume.check, result.coverLetter.check);

  // A2: the deterministic verifier is the block. If a generated résumé/cover letter asserts anything
  // outside the approved ledger, refuse to hand it to an apply path — never attach unverified docs to
  // a live employer form. Preview callers still get the failed check back so the UI can surface it.
  if (!result.allEligible && !previewOnly) {
    throw new DocsBlockedError(
      "Generated documents failed ledger verification — refusing to attach them to a live application. " +
        "Fix or approve the flagged claims in the ledger, then try again.",
      ledgerCheck
    );
  }

  return {
    resumePath: saved.resumePdf,
    coverLetterPath: saved.coverLetterPdf,
    ledgerCheck,
    allEligible: result.allEligible,
    generator: "tailored",
  };
}
