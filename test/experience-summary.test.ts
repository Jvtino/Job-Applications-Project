// The "Summarized" tab engine (src/generation/experience-summary.ts). The point of these tests is the
// ANTI-FABRICATION guarantee: a faithful summary of a role's approved bullets is returned, but a
// summary that invents a number/scope is caught by the ledger check and NEVER surfaced — the engine
// falls back to the role's verbatim bullets instead. Uses stub LLM clients (no network) and the real
// DeterministicLedgerVerifier, so the gate is exercised for real.

import { describe, it, expect } from "vitest";
import { summarizeExperience, bulletsToParagraph } from "../src/generation/experience-summary";
import type { LlmClient } from "../src/llm/types";
import type { EmploymentFact, FactsLedger } from "../src/types/facts-ledger";

const FACT: EmploymentFact = {
  id: "emp1",
  type: "employment",
  approved: true,
  employer: "Northwind Logistics",
  title: "AML Analyst",
  startDate: "2021-03",
  endDate: "present",
  bullets: [
    "Reviewed 120 alerts per week for suspicious activity",
    "Reduced false positive rate by 30% by tuning detection rules",
  ],
};
const LEDGER: FactsLedger = { profileId: "p", facts: [FACT], approvedAt: "2026-01-01T00:00:00Z" };

/** Stub LLM returning fixed text (or a different text per call, for the repair-loop test). */
function stubLlm(...texts: string[]): LlmClient {
  let i = 0;
  return {
    model: "test",
    provider: "test",
    async complete() {
      const text = texts[Math.min(i, texts.length - 1)] ?? "";
      i++;
      return { text };
    },
  };
}

const FAITHFUL =
  "As AML Analyst at Northwind Logistics, reviewed 120 alerts per week for suspicious activity and reduced the false positive rate by 30% by tuning detection rules.";
const FABRICATED =
  "Led a team of 12 analysts and reduced false positives by 95%, saving $2M in annual losses.";

describe("summarizeExperience — anti-fabrication", () => {
  it("returns a faithful LLM paragraph that passes the ledger check", async () => {
    const r = await summarizeExperience(FACT, LEDGER, { client: stubLlm(FAITHFUL) });
    expect(r.ok).toBe(true);
    expect(r.paragraph).toBe(FAITHFUL);
    expect(r.check?.passed).toBe(true);
  });

  it("NEVER surfaces a fabricated paragraph — falls back to the verbatim bullets", async () => {
    const r = await summarizeExperience(FACT, LEDGER, { client: stubLlm(FABRICATED), maxRepairs: 1 });
    expect(r.ok).toBe(true);
    // The invented figures must not appear anywhere in what we return.
    expect(r.paragraph).not.toMatch(/95|team of 12|\$2M/i);
    // The verbatim bullets (the user's own approved words) are what we fall back to.
    expect(r.paragraph).toContain("120 alerts per week");
    expect(r.paragraph).toContain("30%");
    expect(r.reason).toMatch(/verbatim|unsupported/i);
  });

  it("accepts a repaired paragraph when a later attempt stops fabricating", async () => {
    const r = await summarizeExperience(FACT, LEDGER, { client: stubLlm(FABRICATED, FAITHFUL), maxRepairs: 2 });
    expect(r.ok).toBe(true);
    expect(r.paragraph).toBe(FAITHFUL); // the repaired, faithful attempt — not the fabricated first one
    expect(r.check?.passed).toBe(true);
  });

  it("with no LLM configured, returns the role's verbatim bullets (faithful by construction)", async () => {
    const r = await summarizeExperience(FACT, LEDGER, { client: null });
    expect(r.ok).toBe(true);
    expect(r.paragraph).toContain("120 alerts per week");
    expect(r.paragraph).toContain("30%");
    expect(r.reason).toMatch(/no LLM/i);
  });

  it("returns nothing to summarize when the role has no approved bullets", async () => {
    const noBullets: EmploymentFact = { ...FACT, bullets: [] };
    const r = await summarizeExperience(noBullets, { profileId: "p", facts: [noBullets] }, { client: stubLlm(FAITHFUL) });
    expect(r.ok).toBe(false);
    expect(r.paragraph).toBeNull();
    expect(r.reason).toMatch(/no approved bullet/i);
  });
});

describe("bulletsToParagraph", () => {
  it("joins bullets into one paragraph, de-duplicating trailing punctuation", () => {
    expect(bulletsToParagraph(["Did a thing.", "Did another thing"])).toBe("Did a thing. Did another thing.");
    expect(bulletsToParagraph([])).toBe("");
  });
});
