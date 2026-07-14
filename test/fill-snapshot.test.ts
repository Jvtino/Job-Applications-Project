import { describe, it, expect } from "vitest";
import { buildRedactedSnapshot, isSensitiveLabel } from "../src/server/fill-snapshot";
import type { ReviewGate } from "../src/orchestrator/review-gate";

function field(label: string, value: string | string[] | null, ref = label) {
  return {
    field: { ref, label, controlType: "text", required: false, options: [] },
    risk: "low",
    resolvedValue: value,
    source: "user",
    method: "exact",
    confidence: 1,
    rationale: "matched",
  };
}

const gate = {
  url: "https://boards.greenhouse.io/acme/jobs/1",
  ats: "greenhouse",
  company: "Acme",
  title: "Engineer",
  challengeDetected: false,
  filled: [
    field("Full name", "Haci Ahmet Ilhan"),
    field("Email", "x@y.com"),
    field("Gender", "Male"),
    field("Are you authorized to work in the US?", "Yes"),
  ],
  flaggedForReview: [field("Veteran status", "I am a protected veteran")],
  needsConfirmation: [field("Why do you want to work here?", null)],
  attachedDocuments: [{ kind: "resume", attached: true }],
  ledgerCheck: { passed: true },
  readyForOneClickSubmit: false,
} as unknown as ReviewGate;

describe("isSensitiveLabel", () => {
  it("flags protected-class + work-auth + identifiers", () => {
    for (const l of ["Gender", "Race / Ethnicity", "Veteran status", "Disability", "Are you authorized to work in the US?", "Visa sponsorship", "SSN", "Date of birth"]) {
      expect(isSensitiveLabel(l)).toBe(true);
    }
  });
  it("does not flag ordinary fields", () => {
    for (const l of ["Full name", "Email", "Phone", "LinkedIn URL", "Why do you want to work here?", "Years of experience"]) {
      expect(isSensitiveLabel(l)).toBe(false);
    }
  });
});

describe("buildRedactedSnapshot", () => {
  const snap = buildRedactedSnapshot(gate, { submitted: false });

  it("keeps ordinary filled values in plaintext", () => {
    const name = snap.filled.find((f) => f.label === "Full name");
    expect(name?.value).toBe("Haci Ahmet Ilhan");
    expect(name?.redacted).toBe(false);
  });

  it("redacts sensitive filled VALUES but keeps the label", () => {
    const gender = snap.filled.find((f) => f.label === "Gender");
    expect(gender?.value).toBeNull();
    expect(gender?.redacted).toBe(true);
    const auth = snap.filled.find((f) => f.label.startsWith("Are you authorized"));
    expect(auth?.value).toBeNull();
    expect(auth?.redacted).toBe(true);
  });

  it("redacts sensitive flagged values too", () => {
    expect(snap.flagged[0]?.redacted).toBe(true);
    expect(snap.flagged[0]?.value).toBeNull();
  });

  it("counts redactions and preserves structure", () => {
    expect(snap.redactedCount).toBe(3);
    expect(snap.needsConfirmation).toHaveLength(1);
    expect(snap.documents).toEqual([{ kind: "resume", attached: true }]);
    expect(snap.ledger).toEqual({ checked: true, passed: true });
    expect(snap.submitted).toBe(false);
  });

  it("never serializes a sensitive value, even nested", () => {
    const json = JSON.stringify(snap);
    expect(json).not.toContain("protected veteran");
    expect(json).not.toContain("Male");
    expect(json).toContain("Haci Ahmet Ilhan"); // ordinary value is retained
  });
});
