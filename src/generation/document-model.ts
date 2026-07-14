// src/generation/document-model.ts
//
// Structured, render-agnostic models for a generated resume and cover letter, plus the
// flatten-to-text used by the ledger verifier and an em-dash sanitizer (the brief forbids
// em-dashes in the user's voice). Keeping a single structured model means PDF and DOCX render
// identically and the verifier checks exactly what gets rendered.

export interface ResumeExperience {
  /** e.g. "Senior Operations Analyst, Northwind Logistics (2021 - Present)". */
  header: string;
  bullets: string[];
}

export interface ResumeModel {
  name: string;
  /** One or more contact lines (email | phone, then links). */
  contactLines: string[];
  summary?: string;
  experience: ResumeExperience[];
  education: string[];
  skills: string[];
  certifications: string[];
}

export interface CoverLetterModel {
  date: string;
  recipient: string;
  greeting: string;
  paragraphs: string[];
  closing: string; // e.g. "Sincerely,"
  signature: string;
}

/** Remove em-dashes (and normalize en-dashes) to plain hyphens; collapse stray spacing. */
export function sanitizeProse(text: string): string {
  return text
    .replace(/\s*—\s*/g, " - ") // em-dash -> spaced hyphen
    .replace(/–/g, "-") // en-dash -> hyphen
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function sanitizeResume(model: ResumeModel): ResumeModel {
  return {
    name: sanitizeProse(model.name),
    contactLines: model.contactLines.map(sanitizeProse).filter(Boolean),
    ...(model.summary ? { summary: sanitizeProse(model.summary) } : {}),
    experience: model.experience.map((e) => ({
      header: sanitizeProse(e.header),
      bullets: e.bullets.map(sanitizeProse).filter(Boolean),
    })),
    education: model.education.map(sanitizeProse).filter(Boolean),
    skills: model.skills.map(sanitizeProse).filter(Boolean),
    certifications: model.certifications.map(sanitizeProse).filter(Boolean),
  };
}

export function sanitizeCoverLetter(model: CoverLetterModel): CoverLetterModel {
  return {
    date: sanitizeProse(model.date),
    recipient: sanitizeProse(model.recipient),
    greeting: sanitizeProse(model.greeting),
    paragraphs: model.paragraphs.map(sanitizeProse).filter(Boolean),
    closing: sanitizeProse(model.closing),
    signature: sanitizeProse(model.signature),
  };
}

export function resumeToText(model: ResumeModel): string {
  const out: string[] = [model.name, ...model.contactLines];
  if (model.summary) out.push(model.summary);
  for (const exp of model.experience) {
    out.push(exp.header);
    out.push(...exp.bullets);
  }
  out.push(...model.education);
  if (model.skills.length) out.push(`Skills: ${model.skills.join(", ")}`);
  out.push(...model.certifications);
  return out.join("\n");
}

export function coverLetterToText(model: CoverLetterModel): string {
  return [
    model.date,
    model.recipient,
    model.greeting,
    ...model.paragraphs,
    model.closing,
    model.signature,
  ].join("\n");
}
