// src/server/fill-snapshot.ts
//
// Builds the persisted "what the form-fill agent actually produced on this employer form" artifact
// from a review gate, so the Applications tab can show the real field-by-field application.
//
// CRITICAL (brief constraint: "no self-ID / work-auth value auto-submitted unless user-confirmed";
// "never log sensitive values in plaintext beyond what already exists"): protected-class self-ID and
// work-authorization VALUES are NEVER stored in plaintext at rest. We keep each field's LABEL plus a
// `redacted` marker, so the user can see the field was handled without persisting the sensitive answer.
// Pure + unit-tested. This reads gate state; it never submits or alters submission.

import type { ReviewGate } from "../orchestrator/review-gate";

export interface SnapshotFilledField {
  label: string;
  value: string | string[] | null;
  redacted: boolean;
}
export interface SnapshotFlaggedField extends SnapshotFilledField {
  rationale: string;
}
export interface SnapshotPendingField {
  ref: string;
  label: string;
  controlType: string;
  required: boolean;
  risk: string;
  rationale: string;
}
export interface RedactedFillSnapshot {
  url: string;
  ats: string;
  company: string | null;
  title: string | null;
  capturedAt: string;
  submitted: boolean;
  filled: SnapshotFilledField[];
  flagged: SnapshotFlaggedField[];
  needsConfirmation: SnapshotPendingField[];
  documents: { kind: string; attached: boolean }[];
  ledger: { checked: boolean; passed: boolean } | null;
  redactedCount: number;
}

// Protected-class self-ID, immigration / work-authorization, and government identifiers, matched on the
// field LABEL. Kept deliberately broad: a false positive only redacts a value at rest (safe); a miss
// would leak a sensitive value. Anything matched here is stored as redacted.
const SENSITIVE_LABEL =
  /\b(gender|sex|race|ethnic(?:ity)?|hispanic|latino|latina|veteran|disab(?:led|ility)?|sexual orientation|national origin|citizen(?:ship)?|work authoriz(?:ation)?|authorized to work|right to work|sponsor(?:ship)?|visa|immigration|ssn|social security|date of birth|birth date|dob|passport|driver'?s? licen[sc]e)\b/i;

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label || "");
}

function isEmpty(value: string | string[] | null): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  return value.length === 0;
}

function redact(label: string, value: string | string[] | null): { value: string | string[] | null; redacted: boolean } {
  if (isEmpty(value)) return { value: value ?? null, redacted: false };
  if (isSensitiveLabel(label)) return { value: null, redacted: true };
  return { value, redacted: false };
}

/** Build the redacted, at-rest snapshot from a live review gate. */
export function buildRedactedSnapshot(gate: ReviewGate, opts: { submitted: boolean; capturedAt?: string }): RedactedFillSnapshot {
  let redactedCount = 0;

  const filled: SnapshotFilledField[] = gate.filled.map((m) => {
    const r = redact(m.field.label, m.resolvedValue);
    if (r.redacted) redactedCount++;
    return { label: m.field.label, value: r.value, redacted: r.redacted };
  });

  const flagged: SnapshotFlaggedField[] = gate.flaggedForReview.map((m) => {
    const r = redact(m.field.label, m.resolvedValue);
    if (r.redacted) redactedCount++;
    return { label: m.field.label, value: r.value, redacted: r.redacted, rationale: m.rationale };
  });

  const needsConfirmation: SnapshotPendingField[] = gate.needsConfirmation.map((m) => ({
    ref: m.field.ref,
    label: m.field.label,
    controlType: String(m.field.controlType),
    required: m.field.required,
    risk: String(m.risk),
    rationale: m.rationale,
  }));

  return {
    url: gate.url,
    ats: gate.ats,
    company: gate.company ?? null,
    title: gate.title ?? null,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    submitted: opts.submitted,
    filled,
    flagged,
    needsConfirmation,
    documents: gate.attachedDocuments.map((d) => ({ kind: d.kind, attached: d.attached })),
    ledger: gate.ledgerCheck ? { checked: true, passed: gate.ledgerCheck.passed } : null,
    redactedCount,
  };
}
