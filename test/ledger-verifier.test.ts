import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import type { FactsLedger } from "../src/types/facts-ledger";
import { DeterministicLedgerVerifier } from "../src/generation/ledger-verifier";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, "fixtures", name), "utf8");

/** A small, fully-APPROVED ledger to verify documents against. */
function approvedLedger(): FactsLedger {
  return {
    profileId: "p1",
    approvedAt: new Date().toISOString(),
    facts: [
      {
        id: "e1",
        type: "employment",
        approved: true,
        title: "Senior Operations Analyst",
        employer: "Northwind Logistics",
        startDate: "2021",
        endDate: "present",
        bullets: [
          "Reviewed 120 claims per week, reducing backlog by 35%",
          "Led a team of 5 analysts across two regional offices",
        ],
      },
      {
        id: "e2",
        type: "employment",
        approved: true,
        title: "Operations Analyst",
        employer: "Contoso Freight",
        startDate: "2018",
        endDate: "2021",
        bullets: [
          "Built dashboards that cut reporting time by 40%",
          "Processed 90 vendor invoices per month with 99% accuracy",
        ],
      },
      {
        id: "ed1",
        type: "education",
        approved: true,
        institution: "State University",
        degree: "B.S. Industrial Engineering",
        graduationDate: "2018",
      },
      { id: "s1", type: "skill", approved: true, statement: "SQL" },
      { id: "s2", type: "skill", approved: true, statement: "Tableau" },
    ],
  };
}

describe("DeterministicLedgerVerifier", () => {
  it("PASSES a document built only from approved facts", async () => {
    const verifier = new DeterministicLedgerVerifier();
    const result = await verifier.verify(fixture("good-resume.txt"), approvedLedger());

    expect(result.passed).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.supported)).toBe(true);
    // Supported prose claims point at a backing fact.
    expect(result.checks.some((c) => c.supportingFactId)).toBe(true);
  });

  it("FAILS a deliberately fabricated document and names the fabrications", async () => {
    const verifier = new DeterministicLedgerVerifier();
    const result = await verifier.verify(fixture("fabricated-resume.txt"), approvedLedger());

    expect(result.passed).toBe(false);
    const reasons = result.checks
      .filter((c) => !c.supported)
      .map((c) => c.reason)
      .join(" | ");
    // A fabricated employer, an inflated metric, and a fake credential are all caught.
    expect(reasons).toContain("Globex");
    expect(reasons).toContain("250");
    expect(reasons).toMatch(/AWS|Wharton|2022|60/);
  });

  it("blocks even if only ONE claim is unsupported", async () => {
    const verifier = new DeterministicLedgerVerifier();
    const doc =
      "Operations Analyst at Northwind Logistics. Reviewed 120 claims per week. " +
      "Increased revenue by 73%."; // 73 is not in any approved fact
    const result = await verifier.verify(doc, approvedLedger());
    expect(result.passed).toBe(false);
    expect(result.checks.filter((c) => !c.supported)).toHaveLength(1);
  });

  it("does NOT require an LLM (deterministic gate runs fully offline)", async () => {
    // No ANTHROPIC_API_KEY needed; the gate is pure.
    const verifier = new DeterministicLedgerVerifier();
    const result = await verifier.verify(fixture("good-resume.txt"), approvedLedger());
    expect(result.passed).toBe(true);
  });

  it("accepts a legitimate non-ledger entity (target employer) via the allowlist", async () => {
    const coverLetter =
      "I am excited to apply to Initech for the Operations Analyst role. " +
      "At Northwind Logistics I reviewed 120 claims per week.";

    const withAllow = await new DeterministicLedgerVerifier(["Initech"]).verify(
      coverLetter,
      approvedLedger()
    );
    expect(withAllow.passed).toBe(true);

    // Without the allowlist, the unknown target employer is (correctly) flagged.
    const withoutAllow = await new DeterministicLedgerVerifier().verify(
      coverLetter,
      approvedLedger()
    );
    expect(withoutAllow.passed).toBe(false);
    expect(withoutAllow.checks.find((c) => !c.supported)?.reason).toContain("Initech");
  });

  describe("A7: an asserted accomplishment/ownership must trace to an approved fact", () => {
    const verify = (doc: string, allow: string[] = []) => new DeterministicLedgerVerifier(allow).verify(doc, approvedLedger());

    it("FAILS an unsupported leadership/ownership claim with no number or named entity", async () => {
      const r = await verify("Owned the entire compliance program and led company-wide transformation.");
      expect(r.passed).toBe(false);
      expect(r.checks.find((c) => !c.supported)?.reason).toMatch(/experience\/ownership\/leadership/i);
    });

    it("FAILS a leadership claim whose content the ledger does not back at all", async () => {
      // Nothing in the approved ledger mentions a franchise/network; no number, no named entity.
      const r = await verify("Led a nationwide franchise network.");
      expect(r.passed).toBe(false);
      expect(r.checks.find((c) => !c.supported)?.reason).toMatch(/experience\/ownership\/leadership/i);
    });

    it("PASSES a rephrased-but-approved accomplishment", async () => {
      // Approved fact e1: "Led a team of 5 analysts across two regional offices".
      const r = await verify("Led a team of 5 analysts across two regional offices.");
      expect(r.passed).toBe(true);
      expect(r.checks.every((c) => c.supported)).toBe(true);
    });

    it("PASSES accomplishment prose whose content tokens trace to a fact", async () => {
      // "reviewed ... claims ... backlog" all come from approved fact e1.
      const r = await verify("Spearheaded the effort that reviewed claims and reduced backlog by 35%.");
      expect(r.passed).toBe(true);
    });

    it("does NOT flag boilerplate cover-letter prose (no accomplishment verb)", async () => {
      const r = await verify(
        "I am writing to apply for the Operations Analyst position. Thank you for your consideration.",
        ["Operations Analyst"]
      );
      expect(r.passed).toBe(true);
    });
  });

  it("ignores UNAPPROVED facts as support (only approved facts back claims)", async () => {
    const ledger = approvedLedger();
    // Add an unapproved fact that would 'support' an otherwise-unsupported claim.
    ledger.facts.push({
      id: "x1",
      type: "employment",
      approved: false,
      title: "Director",
      employer: "Umbrella Corporation",
      startDate: "2015",
      endDate: "2018",
      bullets: [],
    });
    const doc = "Director at Umbrella Corporation from 2015 to 2018.";
    const result = await new DeterministicLedgerVerifier().verify(doc, ledger);
    expect(result.passed).toBe(false);
    const reason = result.checks.find((c) => !c.supported)?.reason ?? "";
    expect(reason).toMatch(/Umbrella|2015/);
  });
});
