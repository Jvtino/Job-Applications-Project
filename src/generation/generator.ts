// src/generation/generator.ts
//
// Document generators. Both produce the SAME structured models, built strictly from APPROVED
// facts (the substantive content) plus the profile's own contact identity (the header). The
// posting only reorders/reweights facts. Two implementations:
//   - TemplateDocumentGenerator: deterministic, offline, always truthful (restates approved
//     fact text). The safe baseline and the verifiable default.
//   - LlmDocumentGenerator: tailored prose via the Anthropic API, constrained to the facts and
//     forbidden em-dashes; its output is still gated by the verifier in the pipeline.

import { z } from "zod";
import type { ContactInfo, PositioningStatement } from "../types/applicant-profile";
import type { Fact, EmploymentFact } from "../types/facts-ledger";
import type { JobPosting } from "../types/job-posting";
import type { CoverLetterModel, ResumeModel } from "./document-model";
import { sanitizeCoverLetter, sanitizeResume } from "./document-model";
import { relevanceScore } from "./posting";
import { extractJson, type LlmClient } from "../llm/anthropic";
import { cachedComplete, getDefaultLlmCache } from "../llm/cache";

export interface GeneratorContext {
  approvedFacts: Fact[];
  contact: ContactInfo;
  posting: JobPosting;
  /**
   * Optional strategic framing. Steers WHICH approved facts to emphasize and HOW to angle them —
   * it is NOT a source of facts and must not be stated verbatim unless the approved facts support
   * it. The verifier remains the backstop. Used by the LLM generator only; the template generator
   * (truthful by construction) ignores it.
   */
  positioning?: PositioningStatement;
}

/**
 * Render the positioning as prompt guidance, or "" when unset. Framed explicitly as emphasis-only
 * so the LLM treats it as a lens over the approved facts, never as new content to assert.
 */
function positioningGuidance(p?: PositioningStatement): string {
  if (!p) return "";
  const lines = [
    p.whatIDo.trim() ? `- What the candidate does: ${p.whatIDo.trim()}` : "",
    p.whoIServe.trim() ? `- Who they do it for: ${p.whoIServe.trim()}` : "",
    p.whatResult.trim() ? `- The result they produce: ${p.whatResult.trim()}` : "",
  ].filter(Boolean);
  if (lines.length === 0) return "";
  return (
    `STRATEGIC FRAMING (use ONLY to choose which approved facts to emphasize and how to angle the ` +
    `wording — this is NOT a source of facts; do NOT state it verbatim unless the approved facts ` +
    `already support it):\n${lines.join("\n")}\n\n`
  );
}

export interface DocumentGenerator {
  readonly name: string;
  generateResume(ctx: GeneratorContext): Promise<ResumeModel>;
  generateCoverLetter(ctx: GeneratorContext): Promise<CoverLetterModel>;
}

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

export function formatName(c: ContactInfo): string {
  const first = c.preferredName?.trim() || c.legalFirstName;
  return `${first} ${c.legalLastName}`.trim();
}

export function contactLines(c: ContactInfo): string[] {
  const primary = [c.email, c.phone, [c.address.city, c.address.state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" | ");
  const links = [c.links.linkedin, c.links.github, c.links.portfolio]
    .filter(Boolean)
    .join(" | ");
  return [primary, links].filter((l) => l.length > 0);
}

export function formatDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(d);
}

function endYear(f: EmploymentFact): number {
  if (f.endDate === "present") return 999999;
  const m = f.endDate.match(/\d{4}/);
  return m ? Number(m[0]) : 0;
}

function sortedEmployment(facts: Fact[]): EmploymentFact[] {
  return facts
    .filter((f): f is EmploymentFact => f.type === "employment")
    .sort((a, b) => endYear(b) - endYear(a));
}

function rankByRelevance<T>(items: T[], text: (t: T) => string, posting: JobPosting): T[] {
  return items
    .map((item, i) => ({ item, i, score: relevanceScore(text(item), posting) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}

/** Lowercase the first letter so an approved bullet reads naturally after "I ". */
function deCapitalize(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------------------
// Template (deterministic) generator
// ---------------------------------------------------------------------------------------

export class TemplateDocumentGenerator implements DocumentGenerator {
  readonly name = "template";

  async generateResume(ctx: GeneratorContext): Promise<ResumeModel> {
    const { approvedFacts: facts, contact, posting } = ctx;

    const summaryPoints = facts
      .filter((f) => f.type === "summary_point")
      .map((f) => (f as { statement: string }).statement);
    const rankedSummary = rankByRelevance(summaryPoints, (s) => s, posting).slice(0, 2);

    const experience = sortedEmployment(facts).map((e) => ({
      header:
        `${e.title}, ${e.employer}` +
        (e.location ? `, ${e.location}` : "") +
        ` (${e.startDate} - ${e.endDate})`,
      bullets: rankByRelevance(e.bullets, (b) => b, posting),
    }));

    const education = facts
      .filter((f) => f.type === "education")
      .map((f) => {
        const e = f as Extract<Fact, { type: "education" }>;
        return `${e.degree}, ${e.institution}` + (e.graduationDate ? `, ${e.graduationDate}` : "");
      });

    const skills = rankByRelevance(
      facts.filter((f) => f.type === "skill").map((f) => (f as { statement: string }).statement),
      (s) => s,
      posting
    );

    const certifications = facts
      .filter((f) => f.type === "certification")
      .map((f) => {
        const c = f as Extract<Fact, { type: "certification" }>;
        if (c.inProgress) return `${c.name} (in progress)`;
        return c.dateEarned ? `${c.name}, ${c.dateEarned}` : c.name;
      });

    return sanitizeResume({
      name: formatName(contact),
      contactLines: contactLines(contact),
      ...(rankedSummary.length ? { summary: rankedSummary.join(" ") } : {}),
      experience,
      education,
      skills,
      certifications,
    });
  }

  async generateCoverLetter(ctx: GeneratorContext): Promise<CoverLetterModel> {
    const { approvedFacts: facts, contact, posting } = ctx;
    const employment = sortedEmployment(facts);
    const recent = employment[0];

    const topBullets = rankByRelevance(
      employment.flatMap((e) => e.bullets),
      (b) => b,
      posting
    ).slice(0, 3);

    const intro =
      `I am writing to apply for the ${posting.title} position at ${posting.company}.` +
      (recent ? ` I currently serve as ${recent.title} at ${recent.employer}.` : "");

    const bodySentences = topBullets.map((b) => `I ${deCapitalize(b)}.`);
    const body =
      bodySentences.length > 0
        ? bodySentences.join(" ")
        : "My background aligns closely with the requirements of this role.";

    const closing =
      `I would welcome the opportunity to discuss how my experience fits ${posting.company}. ` +
      `Thank you for your consideration.`;

    return sanitizeCoverLetter({
      date: formatDate(),
      recipient: `Hiring Team, ${posting.company}`,
      greeting: "Dear Hiring Manager,",
      paragraphs: [intro, body, closing],
      closing: "Sincerely,",
      signature: formatName(contact),
    });
  }
}

// ---------------------------------------------------------------------------------------
// LLM generator (optional)
// ---------------------------------------------------------------------------------------

const resumeModelSchema = z.object({
  name: z.string(),
  contactLines: z.array(z.string()),
  summary: z.string().optional(),
  experience: z.array(z.object({ header: z.string(), bullets: z.array(z.string()) })),
  education: z.array(z.string()),
  skills: z.array(z.string()),
  certifications: z.array(z.string()),
});

const coverLetterModelSchema = z.object({
  date: z.string(),
  recipient: z.string(),
  greeting: z.string(),
  paragraphs: z.array(z.string()),
  closing: z.string(),
  signature: z.string(),
});

const SYSTEM =
  "You write ATS-friendly resumes and cover letters in a formal, clean voice. ABSOLUTE RULES: " +
  "(1) Use ONLY the facts provided; never invent employers, titles, dates, degrees, " +
  "certifications, metrics, or skills, and never alter any number. (2) Never use em-dashes. " +
  "(3) Output strict JSON only, matching the requested shape.";

export class LlmDocumentGenerator implements DocumentGenerator {
  readonly name = "llm";
  constructor(private readonly client: LlmClient) {}

  private factsBlock(facts: Fact[]): string {
    return facts.map((f, i) => `F${i}: ${JSON.stringify(f)}`).join("\n");
  }

  /** Optional repair guidance fed back after a failed ledger check. */
  feedback?: string;

  async generateResume(ctx: GeneratorContext): Promise<ResumeModel> {
    const prompt =
      `APPROVED FACTS (the ONLY allowed source of substance):\n${this.factsBlock(ctx.approvedFacts)}\n\n` +
      `CONTACT (for the header): ${JSON.stringify(ctx.contact)}\n\n` +
      `JOB POSTING: title="${ctx.posting.title}", company="${ctx.posting.company}". ` +
      `Keywords: ${ctx.posting.keywords.join(", ")}.\n\n` +
      positioningGuidance(ctx.positioning) +
      (this.feedback ? `FIX THESE UNSUPPORTED CLAIMS (remove or correct, do not invent): ${this.feedback}\n\n` : "") +
      `Produce a tailored, single-column resume as JSON: ` +
      `{ "name", "contactLines": string[], "summary"?, "experience": [{"header","bullets":string[]}], ` +
      `"education": string[], "skills": string[], "certifications": string[] }. ` +
      `Emphasize facts relevant to the keywords. Restate metrics exactly.`;
    const raw = await cachedComplete(getDefaultLlmCache(), this.client, "doc-generation@v1", prompt, {
      system: SYSTEM,
      maxTokens: 4096,
      feature: "doc-generation",
      validate: (t) => void resumeModelSchema.parse(extractJson(t)),
    });
    return sanitizeResume(resumeModelSchema.parse(extractJson(raw)));
  }

  async generateCoverLetter(ctx: GeneratorContext): Promise<CoverLetterModel> {
    const prompt =
      `APPROVED FACTS (the ONLY allowed source of substance):\n${this.factsBlock(ctx.approvedFacts)}\n\n` +
      `CONTACT: ${JSON.stringify(ctx.contact)}\n\n` +
      `JOB POSTING: title="${ctx.posting.title}", company="${ctx.posting.company}".\n\n` +
      positioningGuidance(ctx.positioning) +
      (this.feedback ? `FIX THESE UNSUPPORTED CLAIMS (remove or correct, do not invent): ${this.feedback}\n\n` : "") +
      `Produce a formal cover letter (200–300 words total) as JSON: ` +
      `{ "date", "recipient", "greeting", "paragraphs": string[] (exactly 5), "closing", "signature" }.\n` +
      `Each paragraph serves one purpose:\n` +
      `  1. Hook — why THIS company and THIS role, by name.\n` +
      `  2. Value prop — what you bring (drawn from approved facts only).\n` +
      `  3. Proof — one specific, quantified achievement from the approved facts.\n` +
      `  4. Connection — why your background serves THEIR mission or team.\n` +
      `  5. CTA — ask for the conversation (one sentence).\n` +
      `Stay within 300 words. Use only the approved facts; never invent.`;
    const raw = await cachedComplete(getDefaultLlmCache(), this.client, "doc-generation@v1", prompt, {
      system: SYSTEM,
      maxTokens: 2048,
      feature: "doc-generation",
      validate: (t) => void coverLetterModelSchema.parse(extractJson(t)),
    });
    return sanitizeCoverLetter(coverLetterModelSchema.parse(extractJson(raw)));
  }
}
