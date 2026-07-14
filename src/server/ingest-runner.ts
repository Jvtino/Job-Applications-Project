// src/server/ingest-runner.ts
//
// In-app résumé ingest: the GUI equivalent of `npm run ingest`. It runs the SAME pipeline
// (extract text -> parse to candidate facts -> build the ledger) and persists the uploaded file so
// the profile's masterResumePath points at a real file for later attach. CRITICAL: parsed facts are
// stored UNAPPROVED (buildLedger seeds approved:false). Nothing here approves anything — approval is
// a separate, explicit user action (POST /api/ledger), because only approved facts may ever reach a
// generated document. The facts ledger stays SEPARATE from the profile store.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { extractResumeText, extractResumeTextFromBuffer } from "../ingestion/extract-text";
import { parseResume } from "../ingestion/parse-resume";
import { buildLedger } from "../ingestion/ledger-ops";
import { extractProfileFromResume, mergeResumeIntoProfile, countFilledFields } from "../ingestion/profile-from-resume";
import { mapResumeDataToAppFields, type ResumeMappingResult } from "../ingestion/resume-mapper";
import {
  dedupeFacts,
  parseStructuredResume,
  structuredResumeToFacts,
  type ParsedResumeData,
} from "../ingestion/structured-resume";
import { computeResumeInsights } from "../ingestion/resume-insights";
import { ResumeInsightsRepo } from "../db/resume-insights-repo";
import { getLlmClient } from "../llm/client";
import { aiEnabled } from "../llm/capabilities";
import { inferTargetRoles } from "../jobs/role-focus";
import { profileToForm, type ProfileForm } from "./profile-form";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { Fact } from "../types/facts-ledger";
import type { FactsLedger } from "../types/facts-ledger";

const ALLOWED_EXT = new Set([".pdf", ".docx", ".txt", ".md"]);

export interface IngestInput {
  filename: string;
  buffer: Buffer;
  preferLlm?: boolean;
}

export interface IngestOutput {
  ledger: FactsLedger;
  method: string;
  warnings: string[];
  resumePath: string;
  profileFieldsFilled: number;
  profile: ApplicantProfile;
  /** Roles inferred from the parsed facts — shown in the Target Roles preference step. */
  suggestedRoles: string[];
}

export interface ResumeImportDraft {
  filename: string;
  buffer: Buffer;
  format: "pdf" | "docx" | "text";
  extractedText: string;
  parsedResume: ParsedResumeData;
  facts: Fact[];
  method: "llm" | "heuristic";
  warnings: string[];
  mapping: ResumeMappingResult;
  profileFieldsFilled: number;
  suggestedRoles: string[];
}

export interface PersistResumeImportOutput {
  ledger: FactsLedger;
  resumePath: string;
}

export async function prepareResumeImportDraft(
  profile: ApplicantProfile,
  input: IngestInput,
  existingForm: ProfileForm = profileToForm(profile)
): Promise<ResumeImportDraft> {
  const extracted = await extractResumeTextFromBuffer(input.filename, input.buffer);
  // Unset = ride the capability resolver (AI parsing on whenever a model can serve it).
  const preferLlm = input.preferLlm ?? aiEnabled("resume-parse");
  const parsedFacts = await parseResume(extracted.text, { preferLlm });
  const structured = await parseStructuredResume(extracted.text, parsedFacts.facts, { preferLlm });
  const structuredFacts = structured.method === "llm" ? structuredResumeToFacts(structured.data) : [];
  const facts = dedupeFacts([...parsedFacts.facts, ...structuredFacts]);
  const mapping = mapResumeDataToAppFields(structured.data, { existingForm });
  const method = parsedFacts.method === "llm" || structured.method === "llm" ? "llm" : "heuristic";
  return {
    filename: input.filename,
    buffer: input.buffer,
    format: extracted.format,
    extractedText: extracted.text,
    parsedResume: structured.data,
    facts,
    method,
    warnings: [...parsedFacts.warnings, ...structured.warnings],
    mapping,
    profileFieldsFilled: countNewMappedFields(existingForm, mapping.mappedData),
    suggestedRoles: inferTargetRoles(profile, facts),
  };
}

export function persistResumeImportDraft(
  db: DB,
  encryptionKey: Buffer | undefined,
  profile: ApplicantProfile,
  resumesDir: string,
  draft: ResumeImportDraft,
  facts: Fact[] = draft.facts
): PersistResumeImportOutput {
  mkdirSync(resumesDir, { recursive: true });
  const resumePath = writeResumeFile(resumesDir, draft.filename, draft.buffer);
  profile.masterResumePath = resumePath;
  profile.updatedAt = new Date().toISOString();
  new ProfileRepo(db, encryptionKey).save(profile);

  const ledger = buildLedger(profile.id, facts.map((f) => ({ ...f, approved: false })));
  new LedgerRepo(db, encryptionKey).save(ledger);
  new ResumeInsightsRepo(db).set(profile.id, computeResumeInsights(ledger.facts));
  recordAudit(db, profile.id, "resume.import", {
    method: draft.method,
    facts: ledger.facts.length,
    approved: 0,
    profileFieldsFilled: draft.profileFieldsFilled,
  });
  return { ledger, resumePath };
}

export async function ingestResumeBuffer(
  db: DB,
  encryptionKey: Buffer | undefined,
  profile: ApplicantProfile,
  resumesDir: string,
  input: IngestInput
): Promise<IngestOutput> {
  const ext = extname(input.filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported file type "${ext || "(none)"}". Upload a PDF, DOCX, TXT, or MD résumé.`);
  }
  if (input.buffer.length === 0) throw new Error("The uploaded file is empty.");

  mkdirSync(resumesDir, { recursive: true });
  const resumePath = writeResumeFile(resumesDir, input.filename, input.buffer);

  // Prefer the richer LLM extraction whenever a model can actually serve it, unless the caller
  // explicitly opted out. Falls back to the heuristic parser if the LLM call fails.
  const preferLlm = input.preferLlm ?? aiEnabled("resume-parse");
  const extracted = await extractResumeText(resumePath);
  const parsed = await parseResume(extracted.text, { preferLlm });
  const ledger = buildLedger(profile.id, parsed.facts); // facts are UNAPPROVED until the user approves

  const extractedProfile = extractProfileFromResume(parsed.facts, extracted.text);
  profile = mergeResumeIntoProfile(profile, extractedProfile);

  // Save the profile FIRST — the ledgers table has a foreign key onto profiles(id).
  profile.masterResumePath = resumePath;
  profile.updatedAt = new Date().toISOString();
  new ProfileRepo(db, encryptionKey).save(profile);
  new LedgerRepo(db, encryptionKey).save(ledger);

  // Derived, matching-only insights (separate from the literal ledger; never a résumé claim).
  new ResumeInsightsRepo(db).set(profile.id, computeResumeInsights(parsed.facts));

  recordAudit(db, profile.id, "resume.ingest", {
    method: parsed.method,
    facts: ledger.facts.length,
    approved: 0,
    profileFieldsFilled: countFilledFields(extractedProfile),
  });

  return {
    ledger,
    method: parsed.method,
    warnings: parsed.warnings,
    resumePath,
    profileFieldsFilled: countFilledFields(extractedProfile),
    profile,
    suggestedRoles: inferTargetRoles(profile, ledger.facts),
  };
}

function writeResumeFile(resumesDir: string, filename: string, buffer: Buffer): string {
  const safe = basename(filename).replace(/[^\w.\-]+/g, "_");
  const resumePath = join(resumesDir, `${randomUUID().slice(0, 8)}-${safe}`);
  writeFileSync(resumePath, buffer);
  return resumePath;
}

function countNewMappedFields(before: ProfileForm, after: ProfileForm): number {
  let count = 0;
  for (const key of Object.keys(after) as (keyof ProfileForm)[]) {
    if (key === "isNegotiable") continue;
    const oldValue = before[key];
    const newValue = after[key];
    const oldBlank = Array.isArray(oldValue) ? oldValue.length === 0 : String(oldValue ?? "").trim() === "";
    const newFilled = Array.isArray(newValue) ? newValue.length > 0 : String(newValue ?? "").trim() !== "";
    if (oldBlank && newFilled) count++;
  }
  return count;
}
