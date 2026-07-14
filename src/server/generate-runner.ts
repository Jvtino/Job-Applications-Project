// src/server/generate-runner.ts
//
// In-app document generation: the GUI equivalent of `npm run generate`. Generates a tailored résumé
// + cover letter from the APPROVED ledger only, runs them through the anti-fabrication verifier, and
// renders PDF + DOCX. CRITICAL: generation may only restate APPROVED facts — `submissionEligible` is
// false (and surfaced) whenever the verifier blocks a claim it can't trace to an approved fact. No
// browser involved.
//
// Phase 2 additions: ATS keyword-gap report, bullet-strength warnings, and cover-letter gating
// (Tier C and large-portal ATS URLs skip the cover letter entirely before generation).

import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { ApplicationDraftsRepo, type ApplicationDraft } from "../db/application-drafts-repo";
import { dedupKeyForUrl } from "../db/applications-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { parsePosting } from "../generation/posting";
import { generateApplicationDocuments } from "../generation/pipeline";
import { saveGeneratedDocs, saveResumeDocs } from "../generation/render";
import { computeAtsGap, type AtsGapReport } from "../generation/ats-gap";
import { checkBulletStrength, type BulletWarning } from "../generation/bullet-strength";
import { decideCoverLetterGate } from "../generation/cover-letter-gate";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
}

export interface GenerateInput {
  company?: string;
  title?: string;
  location?: string;
  postingText: string;
  useLlm?: boolean;
  /** "A" | "B" | "C" — drives cover-letter gating (Tier C → skip). */
  tier?: string;
  /** Employer's ATS apply URL — triggers portal detection heuristic. */
  postingUrl?: string;
  jobId?: string;
}

export interface GenerateDocSummary {
  eligible: boolean;
  claims: number;
  unsupported: { text: string; reason: string }[];
  /** True when the cover letter was intentionally skipped (not a verifier failure). */
  skipped?: boolean;
  /** Why it was skipped — shown to the user. */
  skipReason?: string;
}

export interface GenerateResult {
  generator: string;
  allEligible: boolean;
  company: string;
  title: string;
  resume: GenerateDocSummary;
  coverLetter: GenerateDocSummary;
  files: string[];
  /** ATS keyword-gap analysis against the pasted job posting. */
  atsGap: AtsGapReport;
  /** Bullet-strength warnings for the generated résumé's experience bullets. */
  bulletWarnings: BulletWarning[];
  /** Saved review packet for this job. */
  draft: ApplicationDraft;
}

function summarize(doc: {
  submissionEligible: boolean;
  check: { checks: { supported: boolean; reason: string; claim: { text: string } }[] };
}): GenerateDocSummary {
  return {
    eligible: doc.submissionEligible,
    claims: doc.check.checks.length,
    unsupported: doc.check.checks.filter((c) => !c.supported).map((c) => ({ text: c.claim.text, reason: c.reason })),
  };
}

export async function runGenerate(
  db: DB,
  encryptionKey: Buffer | undefined,
  generatedDir: string,
  input: GenerateInput,
  opts: { demoMode?: boolean } = {}
): Promise<GenerateResult> {
  const profile = resolveActiveProfile(new ProfileRepo(db, encryptionKey), { demoMode: opts.demoMode });
  if (!profile) throw new Error("No profile yet — set up your profile first.");
  const ledger = new LedgerRepo(db, encryptionKey).get(profile.id);
  if (!ledger) throw new Error("No facts ledger — upload and approve a résumé first.");
  if (!ledger.facts.some((f) => f.approved)) throw new Error("No approved facts yet — approve facts in the Résumé tab first.");

  const posting = parsePosting(input.postingText ?? "", {
    ...(input.title ? { title: input.title } : {}),
    ...(input.company ? { company: input.company } : {}),
    ...(input.location ? { location: input.location } : {}),
  });

  const gate = decideCoverLetterGate({ tier: input.tier, postingUrl: input.postingUrl });

  const result = await generateApplicationDocuments(ledger, profile, posting, {
    useLlm: Boolean(input.useLlm),
    coverLetterGate: gate,
  });

  const slug = slugify(`${posting.company}-${posting.title}`);
  const saved = result.coverLetter.skipped
    ? await saveResumeDocs(result.resume.model, generatedDir, slug)
    : await saveGeneratedDocs(result.resume.model, result.coverLetter.model, generatedDir, slug);

  const atsGap = computeAtsGap(result.resume.text, posting);
  const allBullets = result.resume.model.experience.flatMap((e) => e.bullets);
  const bulletWarnings = checkBulletStrength(allBullets);

  recordAudit(db, profile.id, "documents.generate", {
    company: posting.company,
    title: posting.title,
    generator: result.generator,
    resumeEligible: result.resume.submissionEligible,
    coverLetterEligible: result.coverLetter.submissionEligible,
    coverLetterSkipped: result.coverLetter.skipped ?? false,
  });

  const coverLetterSummary: GenerateDocSummary = result.coverLetter.skipped
    ? { eligible: true, claims: 0, unsupported: [], skipped: true, skipReason: gate.reason }
    : summarize(result.coverLetter);
  const applicationAnswers = profile.dynamicAnswers
    .filter((a) => a.answer !== null)
    .map((a) => ({
      question: a.questionText,
      answer: Array.isArray(a.answer) ? a.answer.join(", ") : String(a.answer),
    }));
  const dedupKey = input.postingUrl
    ? dedupKeyForUrl(input.postingUrl)
    : `${posting.company}/${posting.title}/${posting.location ?? ""}`.toLowerCase().replace(/\s+/g, "-");
  const draft = new ApplicationDraftsRepo(db).upsert({
    profileId: profile.id,
    dedupKey,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    company: posting.company,
    title: posting.title,
    ...(input.postingUrl ? { applyUrl: input.postingUrl } : {}),
    tailoredResumeSummary: result.resume.model.summary ?? result.resume.text.split("\n").slice(0, 4).join("\n"),
    coverLetter: result.coverLetter.text,
    applicationAnswers,
    status: "saved",
  });

  return {
    generator: result.generator,
    allEligible: result.allEligible,
    company: posting.company,
    title: posting.title,
    resume: summarize(result.resume),
    coverLetter: coverLetterSummary,
    files: Object.values(saved),
    atsGap,
    bulletWarnings,
    draft,
  };
}
