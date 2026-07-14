// src/orchestrator/apply-session.ts
//
// A PERSISTENT, VISIBLE apply session for the in-app flow. Unlike `runApplication` (which fills,
// builds a review gate, and lets its caller close the browser), an ApplySession keeps the browser
// OPEN across requests so the human can watch the fill happen and use the real employer page:
//   1. start()         — open a visible browser (the in-app review panel when the desktop shell is
//                        present, a headed window otherwise), fill what we confidently can, and
//                        return the review gate. Only form-fill-supported URLs are accepted.
//   2. setField()      — answer a field the bot couldn't fill (live on the page), as a user-sourced value.
//   3. markSubmitted() — record that the HUMAN clicked submit on the employer's page. The app never
//                        clicks the employer's submit control.
//   4. cancel()        — tear the session down.
//
// The review gate still reports what blocks a submit (submitBlocker) so the UI can tell the user
// what to fix, but the final click is always theirs, on the real page.

import { randomUUID } from "node:crypto";
import type { ApplicantProfile } from "../types/applicant-profile";
import type { FormField, MatchResult } from "../ats/adapter";
import { fillApplication, isMultiStep } from "../ats/adapter";
import { fillMultiStepApplication } from "../ats/multi-step";
import { BrowserSession, type EngineBrowserSession } from "../ats/browser";
import { EmbeddedBrowserSession, embeddedCdpEndpoint } from "../ats/embedded-browser";
import { LayeredFieldMatcher } from "../ats/field-matcher";
import { inspectAccountWall } from "../ats/account";
import type { LedgerCheckResult } from "../generation/ledger-check";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import { ApplicationsRepo, dedupKeyForUrl } from "../db/applications-repo";
import { classifyApplyCapability } from "../jobs/apply-capability";
import { runApplication, type ApplyLiveHandles } from "./apply";
import { buildReviewGate, type ReviewGate } from "./review-gate";
import { coreSubmitBlockers } from "./submit-readiness";

/** Where the session's browser is shown. "embedded" = inside the desktop app's review panel (driven
 *  over CDP); "window" = a visible headed browser window next to the app. Never hidden. */
export type ApplyDisplay = "embedded" | "window";

export interface ApplySessionInput {
  url: string;
  company?: string;
  title?: string;
  resumePath?: string;
  coverLetterPath?: string;
  ledgerCheck?: LedgerCheckResult;
  /** Requested display. "embedded" needs the desktop shell's CDP endpoint; falls back to "window". */
  display?: ApplyDisplay;
}

export interface SubmitResult {
  submitted: boolean;
  reason: string;
  /** A10: set when the review gate still had blockers at the moment the user marked it submitted. */
  warning?: string;
}

/**
 * Why an application isn't ready for the human's submit click yet, or null when it's ready: a
 * challenge, an account/login wall, ANY field still needing input, a missing submit control, or a
 * failed document truth-check. The app never clicks submit — this exists so the UI can tell the
 * user what to resolve before THEY click it on the employer's page. Pure + exported so the gate is
 * unit-testable in isolation.
 */
export function submitBlocker(gate: ReviewGate): string | null {
  if (gate.challengeDetected) return "A human-verification challenge is blocking this form.";
  if (gate.accountAction) return "This site needs a login/account first.";
  if (gate.needsConfirmation.length > 0) {
    const n = gate.needsConfirmation.length;
    return `${n} field${n === 1 ? "" : "s"} still need your input.`;
  }
  if (!gate.submitControlRef) return "Couldn't locate the submit button on this form.";
  if (gate.ledgerCheck && !gate.ledgerCheck.passed) return "The generated documents didn't pass the truth check.";
  return null;
}

/** The session surface the server drives. ApplySession is the real impl; tests inject a fake. */
export interface ApplySessionHandle {
  getId(): string;
  getGate(): ReviewGate;
  /** Where this session's browser is shown ("embedded" panel or headed "window"). */
  getDisplay?(): ApplyDisplay;
  refresh(): Promise<ReviewGate>;
  setField(ref: string, value: string | string[]): Promise<ReviewGate>;
  /** Record that the human submitted on the employer page. Never clicks anything. */
  markSubmitted(): Promise<SubmitResult>;
  cancel(): Promise<void>;
  isDone(): boolean;
}

/** Injectable for tests so the session can run without a real browser. */
export interface ApplySessionDeps {
  makeSession?: () => EngineBrowserSession;
}

/** Resolve the display the session will actually use: embedded needs the desktop shell's CDP endpoint. */
export function resolveApplyDisplay(requested: ApplyDisplay | undefined, cdpEndpoint = embeddedCdpEndpoint()): ApplyDisplay {
  return requested === "embedded" && cdpEndpoint ? "embedded" : "window";
}

export class ApplySession implements ApplySessionHandle {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  private live?: ApplyLiveHandles;
  private gate!: ReviewGate;
  private applicationId!: string;
  private done = false;

  private constructor(
    private readonly session: EngineBrowserSession,
    private readonly db: DB,
    private readonly profile: ApplicantProfile,
    private readonly input: ApplySessionInput,
    private readonly display: ApplyDisplay
  ) {}

  /**
   * Open a VISIBLE browser (in-app panel or headed window), fill, and return a live session paused
   * at the review gate (browser stays open). Refuses URLs without a real form-fill adapter — the
   * discovery→apply contract is enforced here too, so no caller can route an unsupported job into
   * the generic fallback.
   */
  static async start(db: DB, profile: ApplicantProfile, input: ApplySessionInput, deps: ApplySessionDeps = {}): Promise<ApplySession> {
    const capability = classifyApplyCapability(input.url);
    if (capability.capability !== "supported_form_fill") {
      throw new Error(`This job isn't supported for automated form filling. ${capability.reason}`);
    }
    const display = resolveApplyDisplay(input.display);
    const session =
      deps.makeSession?.() ??
      (display === "embedded"
        ? new EmbeddedBrowserSession({ minActionDelayMs: 500, maxActionDelayMs: 1500 })
        : new BrowserSession({ headed: true, minActionDelayMs: 500, maxActionDelayMs: 1500 }));
    const apply = new ApplySession(session, db, profile, input, display);
    await session.start();
    try {
      const outcome = await runApplication(
        session,
        db,
        {
          url: input.url,
          mode: "semi_auto",
          profile,
          accountMode: "prefill",
          ...(input.company ? { company: input.company } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.resumePath ? { resumePath: input.resumePath } : {}),
          ...(input.coverLetterPath ? { coverLetterPath: input.coverLetterPath } : {}),
          ...(input.ledgerCheck ? { ledgerCheck: input.ledgerCheck } : {}),
        },
        { onLive: (h) => (apply.live = h) }
      );
      apply.gate = outcome.gate;
      apply.applicationId = outcome.applicationId;
      return apply;
    } catch (err) {
      await session.close().catch(() => {});
      throw err;
    }
  }

  getId(): string {
    return this.id;
  }
  getGate(): ReviewGate {
    return this.gate;
  }
  getDisplay(): ApplyDisplay {
    return this.display;
  }
  isDone(): boolean {
    return this.done;
  }

  /**
   * After the human solves a CAPTCHA or login in the headed browser, re-check the live page and
   * continue the normal fill/gate flow. This mirrors what a person does: solve the page-level block,
   * then continue reviewing the same form.
   */
  async refresh(): Promise<ReviewGate> {
    if (this.done) throw new Error("This application is already closed.");
    if (!this.live) {
      const outcome = await runApplication(
        this.session,
        this.db,
        {
          url: this.input.url,
          mode: "semi_auto",
          profile: this.profile,
          accountMode: "prefill",
          ...(this.input.company ? { company: this.input.company } : {}),
          ...(this.input.title ? { title: this.input.title } : {}),
          ...(this.input.resumePath ? { resumePath: this.input.resumePath } : {}),
          ...(this.input.coverLetterPath ? { coverLetterPath: this.input.coverLetterPath } : {}),
          ...(this.input.ledgerCheck ? { ledgerCheck: this.input.ledgerCheck } : {}),
        },
        { onLive: (h) => (this.live = h) }
      );
      this.gate = outcome.gate;
      this.applicationId = outcome.applicationId;
      return this.gate;
    }
    const { ctx, adapter } = this.live;

    const wall = await inspectAccountWall(ctx);
    if (wall) return this.gate;

    if (await adapter.hasHumanChallenge(ctx)) {
      this.rebuildGate((report) => {
        report.challengeDetected = true;
      });
      return this.gate;
    }

    const attachedDocuments = await this.attachDocuments();
    const attachedRefs = new Set(attachedDocuments.filter((d) => d.attached).map((d) => d.fieldRef));
    const matcher = new LayeredFieldMatcher();
    // Multi-page wizards (Workday) fill across steps; single-page adapters take the unchanged path.
    // Both return the same FillReport shape, so the gate rebuild below is identical either way.
    const report = isMultiStep(adapter)
      ? await fillMultiStepApplication(adapter, matcher, ctx, this.profile, "semi_auto", {
          pageUrl: this.input.url,
          resolveChallenge: async (c) => ((await adapter.hasHumanChallenge(c)) ? "blocked" : "clear"),
          pace: () => this.session.pace(),
        })
      : await fillApplication(adapter, matcher, ctx, this.profile, "semi_auto", {
          pageUrl: this.input.url,
          resolveChallenge: async (c) => ((await adapter.hasHumanChallenge(c)) ? "blocked" : "clear"),
          pace: () => this.session.pace(),
        });
    report.needsConfirmation = report.needsConfirmation.filter(
      (m) => !(m.field.controlType === "file_upload" && attachedRefs.has(m.field.ref))
    );
    const submit = await adapter.findSubmitControl(ctx);
    this.gate = buildReviewGate({
      url: this.gate.url,
      ats: this.gate.ats,
      mode: this.gate.mode,
      ...(this.gate.company ? { company: this.gate.company } : {}),
      ...(this.gate.title ? { title: this.gate.title } : {}),
      report,
      attachedDocuments,
      ...(this.gate.ledgerCheck ? { ledgerCheck: this.gate.ledgerCheck } : {}),
      ...(submit ? { submitControlRef: submit.ref } : {}),
    });
    recordAudit(this.db, this.profile.id, "application.handoff_resumed", {
      url: this.input.url,
      filled: report.filled.length,
      flagged: report.flaggedForReview.length,
      needsConfirmation: report.needsConfirmation.length,
      challenge: report.challengeDetected,
    });
    return this.gate;
  }

  /**
   * Answer a field the bot left for you, live on the page. The value is recorded as user-sourced
   * (source: "user") — the one provenance the high-stakes fill policy trusts for self-id / work-auth.
   */
  async setField(ref: string, value: string | string[]): Promise<ReviewGate> {
    if (this.done) throw new Error("This application is already closed.");
    if (!this.live) {
      throw new Error("This application can't take field input — it's blocked by a login wall or a human-verification challenge.");
    }
    const existing = this.findMatch(ref);
    const field: FormField | undefined = existing?.field ?? (await this.lookupField(ref));
    if (!field) throw new Error(`Unknown form field.`);

    const { ctx, adapter } = this.live;
    await adapter.setField(ctx, field, value);
    const readback = await adapter.readField(ctx, field);
    if (!valuesEqual(readback, value)) {
      throw new Error(`The form didn't accept that value for "${field.label}". Please check the format and try again.`);
    }

    const filledMatch: MatchResult = {
      field,
      risk: existing?.risk ?? "low_stakes",
      resolvedValue: value,
      source: "user",
      method: "exact",
      confidence: 1,
      rationale: "You provided this value in the app.",
    };
    this.rebuildGate((report) => {
      report.needsConfirmation = report.needsConfirmation.filter((m) => m.field.ref !== ref);
      report.flaggedForReview = report.flaggedForReview.filter((m) => m.field.ref !== ref);
      report.filled = [...report.filled.filter((m) => m.field.ref !== ref), filledMatch];
    });
    recordAudit(this.db, this.profile.id, "application.field_set", { label: field.label });
    return this.gate;
  }

  /**
   * Record that the HUMAN clicked submit on the employer's page. The app never clicks the
   * employer's submit control — this only flips the application row (recorded as needs_review
   * during fill) to submitted and closes the session. No readiness gate: the user is the authority
   * on what they did on the real page (they may have completed fields the gate can't see).
   */
  async markSubmitted(): Promise<SubmitResult> {
    if (this.done) return { submitted: false, reason: "This application is already closed." };
    // A10: the user is the authority on what they did on the real page, so we still record — but if
    // the last review gate had unresolved blockers (a challenge, an account wall, a field still
    // needing input, or a failed document ledger check), surface a warning alongside the record.
    const blocker = coreSubmitBlockers({
      challengeDetected: this.gate.challengeDetected,
      ...(this.gate.accountAction ? { accountAction: this.gate.accountAction } : {}),
      needsConfirmation: this.gate.needsConfirmation,
      ...(this.gate.ledgerCheck ? { ledgerCheck: this.gate.ledgerCheck } : {}),
      ...(this.gate.submitControlRef ? { submitControlRef: this.gate.submitControlRef } : {}),
    });
    const warning = blocker ? `Recorded, but the last review still showed: ${blocker}.` : undefined;
    new ApplicationsRepo(this.db).record({
      profileId: this.profile.id,
      dedupKey: dedupKeyForUrl(this.input.url),
      ...(this.input.company ? { company: this.input.company } : {}),
      ...(this.input.title ? { title: this.input.title } : {}),
      url: this.input.url,
      ats: this.gate.ats,
      mode: "semi_auto",
      status: "submitted",
      submitted: true,
    });
    recordAudit(this.db, this.profile.id, "application.submitted", {
      url: this.input.url,
      ats: this.gate.ats,
      via: "user_manual_click",
    });
    this.done = true;
    await this.session.close().catch(() => {});
    return {
      submitted: true,
      reason: "Recorded — you submitted this on the employer's site.",
      ...(warning ? { warning } : {}),
    };
  }

  async cancel(): Promise<void> {
    if (this.done) return;
    this.done = true;
    await this.session.close().catch(() => {});
  }

  // ---- internals ------------------------------------------------------------------------

  private findMatch(ref: string): MatchResult | undefined {
    return [...this.gate.needsConfirmation, ...this.gate.flaggedForReview, ...this.gate.filled].find((m) => m.field.ref === ref);
  }

  /** Fallback: re-enumerate the live form to find a field by ref not present in the gate lists. */
  private async lookupField(ref: string): Promise<FormField | undefined> {
    if (!this.live) return undefined;
    const fields = await this.live.adapter.getFields(this.live.ctx);
    return fields.find((f) => f.ref === ref);
  }

  private async attachDocuments(): Promise<ReviewGate["attachedDocuments"]> {
    if (!this.live) return [];
    const { adapter, ctx } = this.live;
    const fields = await adapter.getFields(ctx);
    const fileFields = fields.filter((f) => f.controlType === "file_upload");
    const out: ReviewGate["attachedDocuments"] = [];

    const resumeField = fileFields.find((f) => /resume|cv/i.test(f.label)) ?? fileFields[0];
    if (this.input.resumePath && resumeField) {
      await adapter.setField(ctx, resumeField, [this.input.resumePath]);
      const rb = await adapter.readField(ctx, resumeField);
      out.push({ kind: "resume", path: this.input.resumePath, fieldLabel: resumeField.label, fieldRef: resumeField.ref, attached: Boolean(rb) });
    }
    const coverField = fileFields.find((f) => /cover/i.test(f.label));
    if (this.input.coverLetterPath && coverField) {
      await adapter.setField(ctx, coverField, [this.input.coverLetterPath]);
      const rb = await adapter.readField(ctx, coverField);
      out.push({ kind: "cover_letter", path: this.input.coverLetterPath, fieldLabel: coverField.label, fieldRef: coverField.ref, attached: Boolean(rb) });
    }
    return out;
  }

  private rebuildGate(mutate: (report: { filled: MatchResult[]; flaggedForReview: MatchResult[]; needsConfirmation: MatchResult[]; challengeDetected: boolean }) => void): void {
    const report = {
      filled: [...this.gate.filled],
      flaggedForReview: [...this.gate.flaggedForReview],
      needsConfirmation: [...this.gate.needsConfirmation],
      challengeDetected: this.gate.challengeDetected,
    };
    mutate(report);
    this.gate = buildReviewGate({
      url: this.gate.url,
      ats: this.gate.ats,
      mode: this.gate.mode,
      ...(this.gate.company ? { company: this.gate.company } : {}),
      ...(this.gate.title ? { title: this.gate.title } : {}),
      report,
      attachedDocuments: this.gate.attachedDocuments,
      ...(this.gate.ledgerCheck ? { ledgerCheck: this.gate.ledgerCheck } : {}),
      ...(this.gate.accountAction ? { accountAction: this.gate.accountAction } : {}),
      ...(this.gate.submitControlRef ? { submitControlRef: this.gate.submitControlRef } : {}),
    });
  }

}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x) => b.includes(x));
  }
  return a === b;
}
