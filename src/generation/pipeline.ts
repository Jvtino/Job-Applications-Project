// src/generation/pipeline.ts
//
// Generation pipeline: build documents from the APPROVED ledger, then GATE them with the
// deterministic LedgerVerifier before they can ever be submission-eligible. A failed check
// blocks the document and surfaces the offending sentence(s). For the LLM generator we attempt
// a bounded repair loop (feed the unsupported sentences back and regenerate); the template
// generator is truthful by construction and should pass first time.
//
// Identity (the applicant's own name/contact) and posting context (company, role, location)
// are legitimate non-ledger content, so they go on the verifier allowlist. SUBSTANTIVE claims
// (employers, titles, dates, metrics, skills, credentials) still must trace to an approved fact.

import type { ApplicantProfile, ContactInfo } from "../types/applicant-profile";
import type { FactsLedger } from "../types/facts-ledger";
import type { JobPosting } from "../types/job-posting";
import type { LedgerCheckResult } from "./ledger-check";
import type { CoverLetterModel, ResumeModel } from "./document-model";
import type { CoverLetterGate } from "./cover-letter-gate";
import { coverLetterToText, resumeToText } from "./document-model";
import {
  LlmDocumentGenerator,
  TemplateDocumentGenerator,
  formatName,
  type DocumentGenerator,
  type GeneratorContext,
} from "./generator";
import { DeterministicLedgerVerifier } from "./ledger-verifier";
import { getLlmClient } from "../llm/anthropic";

export interface GeneratedDoc<M = ResumeModel | CoverLetterModel> {
  kind: "resume" | "cover_letter";
  model: M;
  text: string;
  check: LedgerCheckResult;
  /** True only if the ledger check passed — the brief's gate for "submission-eligible". */
  submissionEligible: boolean;
  /** True when the document was intentionally skipped by a cover-letter gate (not a verifier failure). */
  skipped?: boolean;
}

export interface GenerationResult {
  generator: string;
  resume: GeneratedDoc<ResumeModel>;
  coverLetter: GeneratedDoc<CoverLetterModel>;
  /** Both docs passed the ledger check. */
  allEligible: boolean;
}

export interface GenerateOptions {
  /** Override the generator (e.g. a stub in tests). */
  generator?: DocumentGenerator;
  /** Use the LLM generator when an API key is configured. */
  useLlm?: boolean;
  /** Max LLM repair attempts per document after a failed check. */
  maxRepairs?: number;
  /** When set and skip=true, the cover letter is skipped entirely (no generation, no file). */
  coverLetterGate?: CoverLetterGate;
}

function identityAllowlist(c: ContactInfo): string[] {
  return [
    formatName(c),
    c.legalFirstName,
    c.legalLastName,
    c.preferredName,
    c.email,
    c.phone,
    c.address.line1,
    c.address.line2,
    c.address.city,
    c.address.state,
    c.address.postalCode,
    c.links.linkedin,
    c.links.github,
    c.links.portfolio,
    ...(c.links.other?.map((o) => o.url) ?? []),
  ].filter((s): s is string => Boolean(s));
}

function postingAllowlist(p: JobPosting): string[] {
  return [p.title, p.company, p.location].filter((s): s is string => Boolean(s));
}

function offendingSentences(check: LedgerCheckResult): string {
  return check.checks
    .filter((c) => !c.supported)
    .map((c) => c.claim.text)
    .join(" | ");
}

export async function generateApplicationDocuments(
  ledger: FactsLedger,
  profile: ApplicantProfile,
  posting: JobPosting,
  opts: GenerateOptions = {}
): Promise<GenerationResult> {
  const approvedFacts = ledger.facts.filter((f) => f.approved);
  if (approvedFacts.length === 0) {
    throw new Error(
      "Cannot generate: the facts ledger has no APPROVED facts. Run `npm run ingest` and approve facts first."
    );
  }

  const ctx: GeneratorContext = {
    approvedFacts,
    contact: profile.contact,
    posting,
    ...(profile.positioning ? { positioning: profile.positioning } : {}),
  };
  const baseAllow = [...identityAllowlist(profile.contact), ...postingAllowlist(posting)];
  const maxRepairs = opts.maxRepairs ?? 1;

  const runWith = async (generator: DocumentGenerator): Promise<GenerationResult> => {
    const resume = await generateAndGate(
      "resume",
      () => generator.generateResume(ctx),
      resumeToText,
      (m) => baseAllow, // resume has no extra date line
      ledger,
      generator,
      maxRepairs
    );

    let coverLetter: GeneratedDoc<CoverLetterModel>;
    if (opts.coverLetterGate?.skip) {
      coverLetter = {
        kind: "cover_letter",
        model: { date: "", recipient: "", greeting: "", paragraphs: [], closing: "", signature: "" },
        text: "",
        check: { passed: true, checks: [] },
        submissionEligible: true,
        skipped: true,
      };
    } else {
      coverLetter = await generateAndGate(
        "cover_letter",
        () => generator.generateCoverLetter(ctx),
        coverLetterToText,
        (m) => [...baseAllow, m.date], // the letter's date numbers are legitimate context
        ledger,
        generator,
        maxRepairs
      );
    }

    return {
      generator: generator.name,
      resume,
      coverLetter,
      allEligible: resume.submissionEligible && (coverLetter.skipped || coverLetter.submissionEligible),
    };
  };

  const generator = pickGenerator(opts);
  try {
    return await runWith(generator);
  } catch (err) {
    // Fail-soft invariant (commercial M3): an LLM generator failure — transport error, malformed
    // JSON, schema mismatch — must never break document prep. The truthful template generator is
    // the deterministic floor. A template failure is a real error and propagates.
    if (generator.name === "template") throw err;
    return await runWith(new TemplateDocumentGenerator());
  }
}

function pickGenerator(opts: GenerateOptions): DocumentGenerator {
  if (opts.generator) return opts.generator;
  if (opts.useLlm) {
    const client = getLlmClient();
    if (client) return new LlmDocumentGenerator(client);
  }
  return new TemplateDocumentGenerator();
}

async function generateAndGate<M extends ResumeModel | CoverLetterModel>(
  kind: GeneratedDoc["kind"],
  generate: () => Promise<M>,
  toText: (m: M) => string,
  allowFor: (m: M) => string[],
  ledger: FactsLedger,
  generator: DocumentGenerator,
  maxRepairs: number
): Promise<GeneratedDoc<M>> {
  let model = await generate();
  let text = toText(model);
  let check = await new DeterministicLedgerVerifier(allowFor(model)).verify(text, ledger);

  // Repair loop (LLM generators expose a `feedback` channel; template won't need it).
  let attempts = 0;
  while (!check.passed && attempts < maxRepairs && "feedback" in generator) {
    (generator as LlmDocumentGenerator).feedback = offendingSentences(check);
    attempts++;
    model = await generate();
    text = toText(model);
    check = await new DeterministicLedgerVerifier(allowFor(model)).verify(text, ledger);
  }
  if ("feedback" in generator) (generator as LlmDocumentGenerator).feedback = undefined;

  return { kind, model, text, check, submissionEligible: check.passed };
}
