// src/orchestrator/review-gate.ts
//
// The review/submit gate (Module 6). In semi_auto everything is filled per policy and then we
// PAUSE here: the human reviews the filled state, the generated docs + ledger check, the match
// rationale, and every field that needs confirmation, then clicks submit themselves. ApplyPilot
// never submits in semi_auto. (A dashboard renders this later; for now it is a data model plus
// a console renderer.)

import type { OperatingMode, FillReport, MatchResult } from "../ats/adapter";
import type { LedgerCheckResult } from "../generation/ledger-check";
import { readyForHumanSubmit } from "./submit-readiness";

export interface AttachedDocument {
  kind: "resume" | "cover_letter" | "other";
  path: string;
  fieldLabel: string;
  fieldRef: string;
  attached: boolean;
}

/** Surfaced when the career site requires an account. The HUMAN creates it; the app only
 *  pre-filled non-secret fields and (optionally) put a generated password on the clipboard. */
export interface AccountAction {
  kind: "register" | "login";
  domain: string;
  /** Labels of the non-secret fields the app pre-filled (never a password). */
  prefilled: string[];
  /** True if a generated password was copied to the clipboard for the user to paste + save. */
  passwordOnClipboard: boolean;
  /** Where the user should save the password (e.g. "1Password"). */
  passwordStore?: string;
}

export interface ReviewGate {
  company?: string;
  title?: string;
  url: string;
  ats: string;
  mode: OperatingMode;
  filled: MatchResult[];
  flaggedForReview: MatchResult[];
  needsConfirmation: MatchResult[];
  attachedDocuments: AttachedDocument[];
  ledgerCheck?: LedgerCheckResult;
  challengeDetected: boolean;
  accountAction?: AccountAction;
  submitControlRef?: string;
  /** semi_auto: the human still clicks submit; true means nothing blocks that click. */
  readyForOneClickSubmit: boolean;
}

export function buildReviewGate(args: {
  url: string;
  ats: string;
  mode: OperatingMode;
  company?: string;
  title?: string;
  report: FillReport;
  attachedDocuments?: AttachedDocument[];
  ledgerCheck?: LedgerCheckResult;
  accountAction?: AccountAction;
  submitControlRef?: string;
}): ReviewGate {
  const gateBody = {
    ...(args.company ? { company: args.company } : {}),
    ...(args.title ? { title: args.title } : {}),
    url: args.url,
    ats: args.ats,
    mode: args.mode,
    filled: args.report.filled,
    flaggedForReview: args.report.flaggedForReview,
    needsConfirmation: args.report.needsConfirmation,
    attachedDocuments: args.attachedDocuments ?? [],
    ...(args.ledgerCheck ? { ledgerCheck: args.ledgerCheck } : {}),
    challengeDetected: args.report.challengeDetected,
    ...(args.accountAction ? { accountAction: args.accountAction } : {}),
    ...(args.submitControlRef ? { submitControlRef: args.submitControlRef } : {}),
  };
  return {
    ...gateBody,
    readyForOneClickSubmit: readyForHumanSubmit(gateBody),
  };
}

export function renderReviewGate(gate: ReviewGate, write: (s: string) => void = (s) => process.stdout.write(s)): void {
  const line = (s = "") => write(s + "\n");
  line("\n========== REVIEW GATE ==========");
  line(`Job:    ${gate.title ?? "(unknown)"} @ ${gate.company ?? "(unknown)"}`);
  line(`URL:    ${gate.url}`);
  line(`ATS:    ${gate.ats}    Mode: ${gate.mode}`);

  if (gate.challengeDetected) {
    line("\n⚠️  Human-verification challenge detected.");
    line("    The browser is paused for you — complete the verification yourself, then continue.");
  }

  if (gate.accountAction) {
    const a = gate.accountAction;
    line(`\n🔐 This site requires an account (${a.kind}) at ${a.domain}.`);
    line("    ApplyPilot does NOT create accounts or enter/store passwords. Over to you:");
    if (a.prefilled.length) line(`      • Pre-filled for you (no password): ${a.prefilled.join(", ")}`);
    if (a.passwordOnClipboard) line(`      • A strong password is on your clipboard — paste it, then SAVE it in ${a.passwordStore ?? "your password manager"}.`);
    line(`      • ${a.kind === "register" ? "Set your password and create the account" : "Sign in"} yourself, then re-run apply for this URL.`);
    line(`      • You only do this ONCE — the login persists in the browser profile, so future runs (incl. auto mode) reuse it.`);
  }

  line(`\nFilled (${gate.filled.length}):`);
  for (const m of gate.filled) line(`  ✓ ${m.field.label} = ${fmt(m.resolvedValue)}  [${m.method} ${pct(m.confidence)}]`);

  if (gate.flaggedForReview.length) {
    line(`\nFlagged for your review (${gate.flaggedForReview.length}) — filled but please confirm:`);
    for (const m of gate.flaggedForReview)
      line(`  ⚑ ${m.field.label} = ${fmt(m.resolvedValue)}  [${riskNote(m)}; ${m.rationale}]`);
  }

  if (gate.needsConfirmation.length) {
    line(`\nNeeds your input (${gate.needsConfirmation.length}) — NOT filled:`);
    for (const m of gate.needsConfirmation)
      line(`  ? ${m.field.label}${m.field.required ? " (required)" : ""}  [${m.rationale}]`);
  }

  if (gate.attachedDocuments.length) {
    line("\nDocuments:");
    for (const d of gate.attachedDocuments)
      line(`  ${d.attached ? "📎" : "✗"} ${d.kind}: ${d.path}${d.attached ? "" : " (NOT attached)"}`);
  }

  if (gate.ledgerCheck) {
    line(`\nLedger check on generated docs: ${gate.ledgerCheck.passed ? "PASS ✅" : "FAIL ❌"}`);
    for (const c of gate.ledgerCheck.checks.filter((c) => !c.supported))
      line(`  • unsupported: "${c.claim.text}" — ${c.reason}`);
  }

  line("\n--------------------------------");
  if (gate.readyForOneClickSubmit) {
    line("Ready for one-click human submit. Review above, then submit in the browser yourself.");
  } else {
    line("NOT ready to submit: resolve the flagged / needed items (and any challenge) first.");
  }
  line(`Submit control: ${gate.submitControlRef ? "located (not clicked)" : "not found"}`);
  line("================================\n");
}

function fmt(v: string | string[] | null): string {
  if (v === null) return "(none)";
  return Array.isArray(v) ? v.join(", ") : v;
}
function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function riskNote(m: MatchResult): string {
  if (m.risk === "self_id" || m.risk === "authorization") return `high-stakes ${m.risk}, source=${m.source}`;
  return `${m.risk}, ${pct(m.confidence)}`;
}
