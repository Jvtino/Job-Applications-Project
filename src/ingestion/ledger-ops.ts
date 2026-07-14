// src/ingestion/ledger-ops.ts
//
// Pure operations over the facts ledger. The ledger is the closed set of TRUE claims; only
// `approved` facts may ever be used by document generation. Parsing seeds it with
// `approved: false` facts; the user approves/edits/adds; generation reads ONLY approved ones.

import { randomUUID } from "node:crypto";
import type { Fact, FactsLedger } from "../types/facts-ledger";

/** Omit that distributes across the Fact union, preserving each member's own fields. */
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** A fact being authored (no id yet) — keeps the discriminated per-type fields. */
export type FactDraft = DistributiveOmit<Fact, "id">;

export function buildLedger(profileId: string, facts: Fact[]): FactsLedger {
  return { profileId, facts };
}

/** The closed set that generation is allowed to use. */
export function approvedFacts(ledger: FactsLedger): Fact[] {
  return ledger.facts.filter((f) => f.approved);
}

export function setApproved(ledger: FactsLedger, id: string, approved: boolean): FactsLedger {
  return {
    ...ledger,
    facts: ledger.facts.map((f) => (f.id === id ? { ...f, approved } : f)),
  };
}

export function approveAll(ledger: FactsLedger): FactsLedger {
  return { ...ledger, facts: ledger.facts.map((f) => ({ ...f, approved: true })) };
}

export function removeFact(ledger: FactsLedger, id: string): FactsLedger {
  return { ...ledger, facts: ledger.facts.filter((f) => f.id !== id) };
}

export function replaceFact(ledger: FactsLedger, updated: Fact): FactsLedger {
  return { ...ledger, facts: ledger.facts.map((f) => (f.id === updated.id ? updated : f)) };
}

/**
 * Inline-edit the text of a statement-bearing fact (skill / language / summary point / achievement /
 * metric). Lets the user correct a mis-parse without re-uploading. Editing re-marks the fact as
 * UNAPPROVED so the user re-confirms the corrected claim before it can reach a generated document.
 * Structured facts (employment / education / certification) are not text-editable here and are left
 * unchanged.
 */
export function editFactStatement(ledger: FactsLedger, id: string, statement: string): FactsLedger {
  const fact = ledger.facts.find((f) => f.id === id);
  const text = statement.trim();
  if (!fact || !text || !("statement" in fact)) return ledger;
  return replaceFact(ledger, { ...fact, statement: text, approved: false });
}

/** Add a user-authored fact. New facts default to approved (the user is asserting them). */
export function addFact(ledger: FactsLedger, fact: FactDraft & { id?: string }): FactsLedger {
  const withId = { ...fact, id: fact.id ?? randomUUID() } as Fact;
  return { ...ledger, facts: [...ledger.facts, withId] };
}

/** Stamp approvedAt once at least one fact is approved (the ledger has been reviewed). */
export function finalizeApproval(ledger: FactsLedger): FactsLedger {
  if (approvedFacts(ledger).length === 0) return ledger;
  return { ...ledger, approvedAt: new Date().toISOString() };
}

export interface LedgerSummary {
  total: number;
  approved: number;
  byType: Record<string, { total: number; approved: number }>;
}

export function summarizeLedger(ledger: FactsLedger): LedgerSummary {
  const byType: LedgerSummary["byType"] = {};
  for (const f of ledger.facts) {
    const bucket = (byType[f.type] ??= { total: 0, approved: 0 });
    bucket.total++;
    if (f.approved) bucket.approved++;
  }
  return { total: ledger.facts.length, approved: approvedFacts(ledger).length, byType };
}

/** One-line human-readable rendering of a fact, for review UIs and audits. */
export function describeFact(f: Fact): string {
  switch (f.type) {
    case "employment":
      return `[employment] ${f.title} @ ${f.employer} (${f.startDate}–${f.endDate})` +
        (f.bullets.length ? ` — ${f.bullets.length} bullet(s)` : "");
    case "education":
      return `[education] ${f.degree} — ${f.institution}` +
        (f.graduationDate ? ` (${f.graduationDate})` : "");
    case "certification":
      return `[certification] ${f.name}` +
        (f.inProgress ? " (in progress)" : f.dateEarned ? ` (${f.dateEarned})` : "");
    case "metric":
      return `[metric] ${f.statement}`;
    default:
      return `[${f.type}] ${f.statement}`;
  }
}
