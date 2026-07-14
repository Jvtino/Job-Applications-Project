// src/generation/ledger-check.ts
//
// Verifies a generated document asserts nothing outside the approved facts ledger.

import type { FactsLedger } from "../types/facts-ledger";

export interface Claim {
  text: string;
}

export interface ClaimCheck {
  claim: Claim;
  supported: boolean;
  supportingFactId?: string;
  reason: string;
}

export interface LedgerCheckResult {
  /** false if ANY claim is unsupported. */
  passed: boolean;
  checks: ClaimCheck[];
}

export interface LedgerVerifier {
  /**
   * Deterministic gate first: every named entity, date, and number in the document must
   * match an approved fact. An LLM may then judge paraphrase fidelity for prose claims, but
   * MUST NOT override a failed deterministic check. Unmatched -> supported:false -> blocks.
   */
  verify(documentText: string, ledger: FactsLedger): Promise<LedgerCheckResult>;
}
