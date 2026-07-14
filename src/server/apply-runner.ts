// src/server/apply-runner.ts
//
// One-click apply for a single discovered job, the GUI equivalent of `npm run apply`. Like the
// dashboard's autopilot run, it is HARD-LOCKED to SEMI mode (fill + queue, NEVER submit) — `mode`
// is fixed below and there is no liveSubmit path, so the UI can never fire a submission. It opens
// the employer's own form, fills what it confidently can, attaches the résumé, locates (never
// clicks) the submit control, and pauses at the review gate.

import { BrowserSession } from "../ats/browser";
import type { DB } from "../db/database";
import { runApplication, type ApplyOutcome } from "../orchestrator/apply";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { LedgerCheckResult } from "../generation/ledger-check";

export interface ApplyOneInput {
  url: string;
  company?: string;
  title?: string;
  resumePath?: string;
  coverLetterPath?: string;
  ledgerCheck?: LedgerCheckResult;
}

export async function applyOneSemi(
  db: DB,
  profile: ApplicantProfile,
  input: ApplyOneInput,
  opts: { headed?: boolean; recordVideoDir?: string } = {}
): Promise<ApplyOutcome> {
  const session = new BrowserSession({
    headed: opts.headed ?? true,
    minActionDelayMs: 1200,
    maxActionDelayMs: 3500,
    ...(opts.recordVideoDir ? { recordVideoDir: opts.recordVideoDir } : {}),
  });
  await session.start();
  try {
    return await runApplication(session, db, {
      url: input.url,
      mode: "semi_auto", // hard-locked: the dashboard never submits
      profile,
      accountMode: "prefill",
      ...(input.company ? { company: input.company } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.resumePath ? { resumePath: input.resumePath } : {}),
      ...(input.coverLetterPath ? { coverLetterPath: input.coverLetterPath } : {}),
      ...(input.ledgerCheck ? { ledgerCheck: input.ledgerCheck } : {}),
    });
  } finally {
    await session.close();
  }
}
