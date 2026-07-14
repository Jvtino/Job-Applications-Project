// src/orchestrator/apply.ts
//
// Application orchestrator (Module 6): open career page → detect ATS → pause on any
// human-verification challenge → attach generated docs → fillApplication(mode) → locate submit → gate.
//
// HARD RULES honored here:
//   - semi_auto never submits; the human clicks submit after reviewing.
//   - challenges ALWAYS pause and hand the browser to the human — never solved or bypassed.
//   - hard dedup + per-company rate limiting gate every run BEFORE opening the page.
//   - auto mode is deprecated; all product apply paths pause at the review gate.

import type { ApplicantProfile } from "../types/applicant-profile";
import type { AtsAdapter, OperatingMode, PageContext } from "../ats/adapter";
import { fillApplication, isMultiStep } from "../ats/adapter";
import { fillMultiStepApplication } from "../ats/multi-step";
import { pickAdapter } from "../ats/adapters";
import { LayeredFieldMatcher } from "../ats/field-matcher";
import type { PlaywrightPageContext } from "../ats/page-context";
import type { EngineBrowserSession } from "../ats/browser";
import { inspectAccountWall, prefillRegistration, generatePassword, copyToClipboard, autoFillLogin, fillPasswordFields, submitAccountForm } from "../ats/account";
import { CredentialsVault } from "../db/credentials-vault";
import { resolveHumanChallenge } from "../ats/challenge";
import type { AutoSubmitDecision } from "./auto-submit";
import type { DB } from "../db/database";
import { recordAudit } from "../db/database";
import {
  ApplicationsRepo,
  dedupKeyForUrl,
  type ApplicationStatus,
  type RateLimitConfig,
} from "../db/applications-repo";
import { AccountsRepo } from "../db/accounts-repo";
import type { LedgerCheckResult } from "../generation/ledger-check";
import {
  buildReviewGate,
  type AttachedDocument,
  type ReviewGate,
} from "./review-gate";

export class UnsupportedAtsError extends Error {}

export interface ApplyInput {
  url: string;
  mode?: OperatingMode; // default semi_auto
  profile: ApplicantProfile;
  resumePath?: string;
  coverLetterPath?: string;
  ledgerCheck?: LedgerCheckResult;
  company?: string;
  title?: string;
  useLlmMatcher?: boolean;
  rateLimit?: RateLimitConfig;
  /** AUTO mode only: this employer is pre-approved for auto-submit (companies.auto_submit_approved). */
  autoSubmitApproved?: boolean;
  /** AUTO mode only: actually click submit when all gates pass. Default false = dry-run. */
  liveSubmit?: boolean;
  /**
   * How to handle a site that requires an account. The app NEVER creates the account, enters a
   * password, or stores credentials — it only detects, optionally pre-fills non-secret fields,
   * optionally puts a generated password on your clipboard, and pauses for you.
   *  - "prefill" (default): pre-fill email/name + suggest a password on the clipboard.
   *  - "handoff": just detect + pause, no pre-fill, no password suggestion.
   *  - "off": ignore account walls (fall through to the normal challenge handling).
   */
  accountMode?: "prefill" | "handoff" | "off";
  /** Where you save passwords (label only, e.g. "1Password"). Never the password itself. */
  passwordStore?: string;
}

/** Live, mutable handles a persistent apply session needs to set fields and submit AFTER fill. */
export interface ApplyLiveHandles {
  ctx: PlaywrightPageContext;
  adapter: AtsAdapter;
}

export interface RunApplicationHooks {
  /**
   * Called once the page is open and the adapter is chosen, BEFORE the gate is returned. Lets a
   * caller keep the live session open (e.g. an in-app review/submit flow) instead of closing it.
   * Not called on the early account-wall return (there is no usable form to act on yet).
   */
  onLive?: (handles: ApplyLiveHandles) => void;
}

export interface ApplyOutcome {
  gate: ReviewGate;
  applicationId: string;
  submitted: boolean;
  /** True when the run paused because the site requires an account you must create. */
  accountRequired?: boolean;
  /** True when this run confirmed a previously-needed login is now active (session persisted). */
  sessionActivated?: boolean;
  /** AUTO mode: the gated decision about whether this application was auto-submitted. */
  autoSubmitDecision?: AutoSubmitDecision;
  /** True when the run refused to attach/proceed because generated docs failed ledger verification. */
  blocked?: boolean;
  /** Plain-language reason when blocked. */
  blockedReason?: string;
  /** Set when the run needs YOU before it can proceed — a login/account wall or a CAPTCHA. The job is parked for the "Needs you" queue; the batch continues. */
  needsYou?: { reason: "login" | "captcha"; label: string };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}


async function attachDocuments(
  adapter: AtsAdapter,
  ctx: PlaywrightPageContext,
  resumePath?: string,
  coverLetterPath?: string
): Promise<AttachedDocument[]> {
  const fields = await adapter.getFields(ctx);
  const fileFields = fields.filter((f) => f.controlType === "file_upload");
  const out: AttachedDocument[] = [];

  const resumeField = fileFields.find((f) => /resume|cv/i.test(f.label)) ?? fileFields[0];
  if (resumePath && resumeField) {
    await adapter.setField(ctx, resumeField, [resumePath]);
    const rb = await adapter.readField(ctx, resumeField);
    out.push({ kind: "resume", path: resumePath, fieldLabel: resumeField.label, fieldRef: resumeField.ref, attached: Boolean(rb) });
  }
  const coverField = fileFields.find((f) => /cover/i.test(f.label));
  if (coverLetterPath && coverField) {
    await adapter.setField(ctx, coverField, [coverLetterPath]);
    const rb = await adapter.readField(ctx, coverField);
    out.push({ kind: "cover_letter", path: coverLetterPath, fieldLabel: coverField.label, fieldRef: coverField.ref, attached: Boolean(rb) });
  }
  return out;
}

export async function runApplication(
  session: EngineBrowserSession,
  db: DB,
  input: ApplyInput,
  hooks: RunApplicationHooks = {}
): Promise<ApplyOutcome> {
  const mode: OperatingMode = input.mode ?? "semi_auto";
  const apps = new ApplicationsRepo(db);
  const dedupKey = dedupKeyForUrl(input.url);
  const domain = safeHost(input.url);
  const accountsRepo = new AccountsRepo(db);

  // A2 defensive gate (defense-in-depth): if the caller handed us a ledger check that FAILED, refuse
  // to open the page or attach documents — even if the caller forgot to check. The verifier is the
  // block; unverified generated documents never reach a live employer form. Runs before any browser
  // work so nothing is opened.
  if (input.ledgerCheck && input.ledgerCheck.passed === false) {
    const reason = "Generated documents failed ledger verification; refusing to attach or proceed.";
    const rec = apps.record({
      profileId: input.profile.id,
      dedupKey,
      ...(input.company ? { company: input.company } : {}),
      ...(input.title ? { title: input.title } : {}),
      url: input.url,
      ats: "blocked",
      mode,
      status: "needs_review",
      submitted: false,
    });
    recordAudit(db, input.profile.id, "application.ledger_blocked", { url: input.url, reason });
    const gate = buildReviewGate({
      url: input.url,
      ats: "blocked",
      mode,
      ...(input.company ? { company: input.company } : {}),
      ...(input.title ? { title: input.title } : {}),
      report: { filled: [], flaggedForReview: [], needsConfirmation: [], challengeDetected: false },
      ledgerCheck: input.ledgerCheck,
    });
    return { gate, applicationId: rec.id, submitted: false, blocked: true, blockedReason: reason };
  }

  // Gate BEFORE opening the page: never SUBMIT the same job twice. (Paused attempts can retry.)
  apps.assertCanApply(input.profile.id, dedupKey, input.company, input.rateLimit);

  const ctx = await session.open(input.url);

  const record = (status: ApplicationStatus, ats: string) =>
    apps.record({
      profileId: input.profile.id,
      dedupKey,
      ...(input.company ? { company: input.company } : {}),
      ...(input.title ? { title: input.title } : {}),
      url: input.url,
      ats,
      mode,
      status,
      submitted: false,
    });

  // Account/login wall FIRST (an account/login page may not even be a recognized ATS form).
  // Owner-approved amendment (see BUILD_BRIEF.md #5): with a SAVED login we auto-fill + submit; with
  // no account we generate + SAVE a password and click Create. We still NEVER solve a CAPTCHA and
  // still hand off at email verification (we pause after a signup submit). accountMode "handoff"
  // keeps the old non-secret prefill + hand-off behavior.
  const accountMode = input.accountMode ?? "prefill";
  if (accountMode !== "off") {
    let wall = await inspectAccountWall(ctx);
    if (wall) {
      const ats = (await pickAdapter(ctx)).name;
      const vault = new CredentialsVault();
      accountsRepo.upsert({
        profileId: input.profile.id,
        domain,
        username: input.profile.contact.email || undefined,
        accountExists: wall.kind === "login",
        ...(input.passwordStore ? { passwordStore: input.passwordStore } : {}),
      });
      accountsRepo.markNeedsLogin(input.profile.id, domain); // session not authenticated (wall is showing)

      // 1) Saved login + a login wall -> auto-fill and submit, then re-check. If the wall clears
      //    (and no new challenge), fall through to the normal fill. If a 2FA/challenge/second wall
      //    appears, we drop through to the pause below and hand off.
      if (wall.kind === "login" && accountMode !== "handoff") {
        const saved = vault.getPassword(domain);
        // Defense-in-depth: only type the saved password when the LIVE page host still equals the
        // domain the credential was saved for — so a redirect to a different host can never receive it.
        if (saved && safeHost(ctx.url) === domain) {
          await autoFillLogin(ctx, wall, saved);
          wall = await inspectAccountWall(ctx);
          if (!wall) {
            accountsRepo.markLoggedIn(input.profile.id, domain);
            recordAudit(db, input.profile.id, "account.auto_login", { domain }); // never logs the secret
          }
        }
      }

      if (wall) {
        let prefilled: string[] = [];
        let passwordOnClipboard = false;
        let accountCreated = false;

        if (wall.kind === "register" && accountMode !== "handoff") {
          // Assisted account creation: generate a strong password, SAVE it to the vault, fill the
          // signup (incl. the password), and click Create. Always pause afterward — email
          // verification / any CAPTCHA is out-of-band and handed to the user (never solved).
          const password = generatePassword();
          vault.set({ domain, email: input.profile.contact.email, password, origin: "generated" });
          prefilled = await prefillRegistration(ctx, input.profile.contact, wall);
          await fillPasswordFields(ctx, password);
          await submitAccountForm(ctx, wall);
          accountCreated = true;
        } else if (accountMode === "prefill") {
          prefilled = await prefillRegistration(ctx, input.profile.contact, wall); // never password, never submit
          if (wall.kind === "register") {
            passwordOnClipboard = await copyToClipboard(generatePassword()); // app never stores it
          }
        }

        const rec = record("account_required", ats);
        recordAudit(db, input.profile.id, "application.account_required", { domain, kind: wall.kind, prefilled: prefilled.length, accountCreated });
        const gate = buildReviewGate({
          url: input.url,
          ats,
          mode,
          ...(input.company ? { company: input.company } : {}),
          ...(input.title ? { title: input.title } : {}),
          report: { filled: [], flaggedForReview: [], needsConfirmation: [], challengeDetected: false },
          accountAction: {
            kind: wall.kind,
            domain,
            prefilled,
            passwordOnClipboard,
            ...(input.passwordStore ? { passwordStore: input.passwordStore } : {}),
          },
        });
        return {
          gate,
          applicationId: rec.id,
          submitted: false,
          accountRequired: true,
          needsYou: { reason: "login", label: "Log in / create an account to finish" },
        };
      }
      // wall cleared by auto-login -> fall through to the normal challenge check + fill below.
    }
  }

  // No account/login wall on this page. If this site previously required a login, the persistent
  // browser session is now authenticated -> remember it so auto mode can reuse the login (no
  // stored credentials, just the live session cookie in the browser profile).
  let sessionActivated = false;
  const priorAccount = accountsRepo.get(input.profile.id, domain);
  if (priorAccount && !priorAccount.loggedIn) {
    accountsRepo.markLoggedIn(input.profile.id, domain);
    recordAudit(db, input.profile.id, "session.active", { domain });
    sessionActivated = true;
  }

  const adapter = await pickAdapter(ctx);
  // Hand the live page + adapter to a caller that wants to keep the session open (in-app review).
  hooks.onLive?.({ ctx, adapter });

  const challengeResolver = (c: PageContext) => resolveHumanChallenge(adapter, c);

  // Early challenge check — a detected challenge always pauses and hands the browser to the human.
  if ((await challengeResolver(ctx)) === "blocked") {
    const rec = record("challenge", adapter.name);
    recordAudit(db, input.profile.id, "application.challenge", { url: input.url, ats: adapter.name });
    const gate = buildReviewGate({
      url: input.url,
      ats: adapter.name,
      mode,
      ...(input.company ? { company: input.company } : {}),
      ...(input.title ? { title: input.title } : {}),
      report: { filled: [], flaggedForReview: [], needsConfirmation: [], challengeDetected: true },
    });
    return {
      gate,
      applicationId: rec.id,
      submitted: false,
      needsYou: { reason: "captcha", label: "Human verification (CAPTCHA) — open it to finish" },
      ...(sessionActivated ? { sessionActivated } : {}),
    };
  }

  const attachedDocuments = await attachDocuments(adapter, ctx, input.resumePath, input.coverLetterPath);

  const matcher = new LayeredFieldMatcher({ useLlm: input.useLlmMatcher ?? false });
  // Multi-page wizards (Workday) fill across steps; single-page adapters — every real adapter today —
  // take the unchanged single-pass path. Both return the same FillReport shape, so everything below
  // (needsConfirmation filtering, findSubmitControl, the review gate) is identical either way.
  const report = isMultiStep(adapter)
    ? await fillMultiStepApplication(adapter, matcher, ctx, input.profile, mode, {
        resolveChallenge: challengeResolver,
        pageUrl: input.url,
        pace: () => session.pace(),
      })
    : await fillApplication(adapter, matcher, ctx, input.profile, mode, {
        resolveChallenge: challengeResolver,
        pageUrl: input.url,
        pace: () => session.pace(),
      });

  // A required file field we already satisfied by attaching a document should not also nag the
  // human as "needs confirmation"; the attachment is shown in the gate's documents section.
  const attachedRefs = new Set(attachedDocuments.filter((d) => d.attached).map((d) => d.fieldRef));
  report.needsConfirmation = report.needsConfirmation.filter(
    (m) => !(m.field.controlType === "file_upload" && attachedRefs.has(m.field.ref))
  );

  const submit = await adapter.findSubmitControl(ctx); // located, NOT clicked

  const gate = buildReviewGate({
    url: input.url,
    ats: adapter.name,
    mode,
    ...(input.company ? { company: input.company } : {}),
    ...(input.title ? { title: input.title } : {}),
    report,
    attachedDocuments,
    ...(input.ledgerCheck ? { ledgerCheck: input.ledgerCheck } : {}),
    ...(submit ? { submitControlRef: submit.ref } : {}),
  });

  const status: ApplicationStatus = report.challengeDetected ? "challenge" : "needs_review";
  const rec = record(status, adapter.name);
  recordAudit(db, input.profile.id, "application.fill", {
    url: input.url,
    ats: adapter.name,
    mode,
    filled: report.filled.length,
    flagged: report.flaggedForReview.length,
    needsConfirmation: report.needsConfirmation.length,
    challenge: report.challengeDetected,
    submitted: false,
  });

  // All product apply paths pause at the review gate — the user clicks Submit in the browser.
  if (mode === "auto") {
    recordAudit(db, input.profile.id, "application.auto_rejected", {
      url: input.url,
      reason: "auto mode removed from product; use semi_auto",
    });
  }

  // A challenge surfaced only after the fill pass (late CAPTCHA/human-check) parks the job for you
  // the same way an early challenge does — never solved, handed off, batch continues.
  const needsYou = report.challengeDetected
    ? { reason: "captcha" as const, label: "Human verification (CAPTCHA) — open it to finish" }
    : undefined;

  // semi_auto / manual: PAUSE for one-click human submit.
  return {
    gate,
    applicationId: rec.id,
    submitted: false,
    ...(needsYou ? { needsYou } : {}),
    ...(sessionActivated ? { sessionActivated } : {}),
  };
}
