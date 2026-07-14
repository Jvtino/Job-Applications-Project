// Résumé-ledger grouping + approvability (commercial M10). Pins that facts land in the right display
// section (in order, empties dropped) and that only free-text fact types are edit-then-approve.
import { describe, it, expect } from "vitest";
import { resumeSections, isEditableFact, EDITABLE_FACT_TYPES } from "./resume-facts";
import type { LedgerFact } from "../data";

let seq = 0;
const fact = (type: string): LedgerFact => ({
  id: `f${seq++}`,
  type,
  approved: false,
  display: `[${type}] value`,
  sourceText: "src",
});

describe("resumeSections", () => {
  it("groups facts into the fixed section order and drops empty sections", () => {
    const sections = resumeSections([fact("skill"), fact("employment"), fact("contact")]);
    expect(sections.map((s) => s.key)).toEqual(["employment", "skills", "contact"]);
    expect(sections.every((s) => s.facts.length > 0)).toBe(true);
  });

  it("folds multiple fact types into the combined 'Highlights' and 'Credentials' sections", () => {
    const sections = resumeSections([
      fact("achievement"),
      fact("metric"),
      fact("summary_point"),
      fact("certification"),
      fact("language"),
    ]);
    const proof = sections.find((s) => s.key === "proof");
    const credentials = sections.find((s) => s.key === "credentials");
    expect(proof?.facts).toHaveLength(3);
    expect(credentials?.facts).toHaveLength(2);
  });

  it("returns nothing for an empty ledger", () => {
    expect(resumeSections([])).toEqual([]);
  });

  it("ignores fact types that map to no section", () => {
    expect(resumeSections([fact("mystery_type")])).toEqual([]);
  });
});

describe("isEditableFact / EDITABLE_FACT_TYPES", () => {
  it("free-text fact types are edit-then-approve", () => {
    for (const t of ["skill", "language", "summary_point", "achievement", "metric", "contact"]) {
      expect(isEditableFact({ type: t })).toBe(true);
      expect(EDITABLE_FACT_TYPES.has(t)).toBe(true);
    }
  });
  it("structured facts (employment, education, certification) are approve-as-parsed only", () => {
    for (const t of ["employment", "education", "certification"]) {
      expect(isEditableFact({ type: t })).toBe(false);
    }
  });
});
