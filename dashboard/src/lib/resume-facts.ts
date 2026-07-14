// Résumé-ledger grouping + approvability, extracted from the résumé import/review UI (commercial M10).
// `resumeSections` turns a flat ledger into the display sections the review screens render;
// `EDITABLE_FACT_TYPES`/`isEditableFact` say which parsed facts the user may approve-and-edit inline
// (structured facts like employment/education are approve-only). Pure so both monolith views share one
// definition and it can be pinned without rendering.
import type { LedgerFact } from "../data";

export interface ResumeSection {
  key: string;
  label: string;
  types: string[];
  facts: LedgerFact[];
}

const SECTION_ORDER: { key: string; label: string; types: string[] }[] = [
  { key: "employment", label: "Experience", types: ["employment"] },
  { key: "skills", label: "Skills", types: ["skill"] },
  { key: "education", label: "Education", types: ["education"] },
  { key: "proof", label: "Highlights", types: ["achievement", "metric", "summary_point"] },
  { key: "credentials", label: "Credentials", types: ["certification", "language"] },
  { key: "contact", label: "Contact", types: ["contact"] },
];

/** Group facts into ordered display sections, dropping any section with no facts. */
export function resumeSections(facts: LedgerFact[]): ResumeSection[] {
  return SECTION_ORDER.map((section) => ({
    ...section,
    facts: facts.filter((fact) => section.types.includes(fact.type)),
  })).filter((section) => section.facts.length > 0);
}

/** Fact types the user may edit-then-approve inline; others are approve-as-parsed only. */
export const EDITABLE_FACT_TYPES = new Set(["skill", "language", "summary_point", "achievement", "metric", "contact"]);

export function isEditableFact(fact: Pick<LedgerFact, "type">): boolean {
  return EDITABLE_FACT_TYPES.has(fact.type);
}
