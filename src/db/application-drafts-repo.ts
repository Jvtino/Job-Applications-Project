// Saved application drafts: generated packets the user can review, track, and reuse.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";

export type ApplicationDraftStatus = "saved" | "applied" | "interviewing" | "rejected" | "offer";

export interface ApplicationDraft {
  id: string;
  profileId: string;
  dedupKey: string;
  jobId?: string;
  company?: string;
  title?: string;
  applyUrl?: string;
  tailoredResumeSummary: string;
  coverLetter: string;
  applicationAnswers: { question: string; answer: string }[];
  status: ApplicationDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export class ApplicationDraftsRepo {
  constructor(private readonly db: DB) {}

  list(profileId: string): ApplicationDraft[] {
    const rows = this.db
      .prepare("SELECT * FROM application_drafts WHERE profile_id = ? ORDER BY updated_at DESC")
      .all(profileId) as DraftRow[];
    return rows.map(fromRow);
  }

  upsert(input: Omit<ApplicationDraft, "id" | "createdAt" | "updatedAt"> & { id?: string; createdAt?: string; updatedAt?: string }): ApplicationDraft {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id, created_at, status FROM application_drafts WHERE profile_id = ? AND dedup_key = ?")
      .get(input.profileId, input.dedupKey) as { id: string; created_at: string; status: ApplicationDraftStatus } | undefined;
    const full: ApplicationDraft = {
      id: input.id ?? existing?.id ?? randomUUID(),
      createdAt: input.createdAt ?? existing?.created_at ?? now,
      updatedAt: input.updatedAt ?? now,
      ...input,
      status: input.status ?? existing?.status ?? "saved",
    };
    this.db
      .prepare(
        `INSERT INTO application_drafts
          (id, profile_id, job_id, dedup_key, company, title, apply_url, tailored_resume_summary, cover_letter, application_answers, status, created_at, updated_at)
         VALUES
          (@id, @profile_id, @job_id, @dedup_key, @company, @title, @apply_url, @tailored_resume_summary, @cover_letter, @application_answers, @status, @created_at, @updated_at)
         ON CONFLICT(profile_id, dedup_key) DO UPDATE SET
          job_id = excluded.job_id,
          company = excluded.company,
          title = excluded.title,
          apply_url = excluded.apply_url,
          tailored_resume_summary = excluded.tailored_resume_summary,
          cover_letter = excluded.cover_letter,
          application_answers = excluded.application_answers,
          updated_at = excluded.updated_at`
      )
      .run(toRow(full));
    return full;
  }

  setStatus(profileId: string, id: string, status: ApplicationDraftStatus): boolean {
    const r = this.db
      .prepare("UPDATE application_drafts SET status = ?, updated_at = ? WHERE profile_id = ? AND id = ?")
      .run(status, new Date().toISOString(), profileId, id);
    return r.changes > 0;
  }
}

interface DraftRow {
  id: string;
  profile_id: string;
  job_id: string | null;
  dedup_key: string;
  company: string | null;
  title: string | null;
  apply_url: string | null;
  tailored_resume_summary: string | null;
  cover_letter: string | null;
  application_answers: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function fromRow(row: DraftRow): ApplicationDraft {
  let answers: ApplicationDraft["applicationAnswers"] = [];
  try {
    answers = row.application_answers ? JSON.parse(row.application_answers) as ApplicationDraft["applicationAnswers"] : [];
  } catch {
    answers = [];
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    dedupKey: row.dedup_key,
    ...(row.job_id ? { jobId: row.job_id } : {}),
    ...(row.company ? { company: row.company } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.apply_url ? { applyUrl: row.apply_url } : {}),
    tailoredResumeSummary: row.tailored_resume_summary ?? "",
    coverLetter: row.cover_letter ?? "",
    applicationAnswers: answers,
    status: row.status as ApplicationDraftStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(draft: ApplicationDraft): Record<string, unknown> {
  return {
    id: draft.id,
    profile_id: draft.profileId,
    job_id: draft.jobId ?? null,
    dedup_key: draft.dedupKey,
    company: draft.company ?? null,
    title: draft.title ?? null,
    apply_url: draft.applyUrl ?? null,
    tailored_resume_summary: draft.tailoredResumeSummary,
    cover_letter: draft.coverLetter,
    application_answers: JSON.stringify(draft.applicationAnswers),
    status: draft.status,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  };
}
