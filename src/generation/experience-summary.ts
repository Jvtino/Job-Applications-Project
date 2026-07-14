// src/generation/experience-summary.ts
//
// The "Summarized" tab engine: turn a role's APPROVED accomplishment bullets into ONE clean
// paragraph for Workday's free-text "Role Description" field — WITHOUT ever introducing a claim the
// facts ledger doesn't support (hard constraint #4, never fabricate).
//
// It reuses the same anti-fabrication gate document generation uses: every generated paragraph is
// run through the DeterministicLedgerVerifier, which fails on any number / named entity / asserted
// accomplishment that doesn't trace to an approved fact. A failed paragraph is NEVER surfaced. On
// failure we retry with the offending sentences fed back, and if that still can't produce a faithful
// paragraph we fall back to the role's own verbatim bullets (faithful by construction) — so the user
// always gets something truthful, never something invented.

import type { EmploymentFact, FactsLedger } from "../types/facts-ledger";
import type { LedgerCheckResult, LedgerVerifier } from "./ledger-check";
import { createLedgerVerifier } from "./ledger-verifier";
import type { LlmClient } from "../llm/types";

export interface ExperienceSummary {
  factId: string;
  employer: string;
  title: string;
  /** The faithful paragraph, or null when no paragraph could pass the ledger check. */
  paragraph: string | null;
  /** True when a paragraph passed the anti-fabrication gate and is safe to use. */
  ok: boolean;
  /** The ledger check for the paragraph we returned (null when there was nothing to check). */
  check: LedgerCheckResult | null;
  /** How the paragraph was produced / why it was withheld. */
  reason?: string;
}

export interface SummarizeExperienceDeps {
  /** LLM client for prose. Omit / null -> deterministic fallback (the verbatim bullets), still gated. */
  client?: LlmClient | null;
  /** Override the verifier (tests). Defaults to the deterministic ledger verifier. */
  verifier?: LedgerVerifier;
  /** How many times to retry after a failed ledger check before falling back. Default 2. */
  maxRepairs?: number;
}

const SUMMARY_SYSTEM =
  "You rewrite approved resume accomplishment bullets into ONE concise, professional paragraph for a " +
  "job application's Role Description field. Use ONLY the information in the bullets. Never add, infer, " +
  "or embellish any metric, number, employer, technology, tool, scope, team size, or achievement. Keep " +
  "every number and named entity exactly as written. Write in a resume voice. Output only the paragraph.";

/** Deterministic, trivially-faithful fallback: the role's own bullets, joined into prose. */
export function bulletsToParagraph(bullets: string[]): string {
  const parts = bullets.map((b) => b.trim().replace(/[.\s]+$/, "")).filter(Boolean);
  return parts.length ? parts.join(". ") + "." : "";
}

function offendingSentences(check: LedgerCheckResult): string {
  return check.checks
    .filter((c) => !c.supported)
    .map((c) => c.claim.text)
    .slice(0, 3)
    .join(" | ");
}

export async function summarizeExperience(
  fact: EmploymentFact,
  ledger: FactsLedger,
  deps: SummarizeExperienceDeps = {}
): Promise<ExperienceSummary> {
  const base = { factId: fact.id, employer: fact.employer, title: fact.title };
  const bullets = (fact.bullets ?? []).map((b) => b.trim()).filter(Boolean);
  if (bullets.length === 0) {
    return { ...base, paragraph: null, ok: false, check: null, reason: "no approved bullet points for this role" };
  }

  // The role's own identity is legitimate context, not fabrication.
  const allowlist = [fact.employer, fact.title, fact.location ?? "", fact.startDate, String(fact.endDate)].filter(Boolean);
  const verifier = deps.verifier ?? createLedgerVerifier({ allowlist });
  const maxRepairs = deps.maxRepairs ?? 2;
  const client = deps.client ?? null;

  const gatedFallback = async (reason: string): Promise<ExperienceSummary> => {
    const paragraph = bulletsToParagraph(bullets);
    const check = await verifier.verify(paragraph, ledger);
    return check.passed
      ? { ...base, paragraph, ok: true, check, reason }
      : { ...base, paragraph: null, ok: false, check, reason: "verbatim bullets did not pass the ledger check" };
  };

  // No LLM -> the verbatim bullets are the user's own approved words: faithful by construction.
  if (!client) return gatedFallback("no LLM configured; used the role's verbatim bullets");

  const buildPrompt = (feedback?: string): string =>
    `ROLE: ${fact.title} at ${fact.employer}\n` +
    `APPROVED BULLETS:\n${bullets.map((b) => `- ${b}`).join("\n")}\n\n` +
    (feedback
      ? `A previous attempt introduced claims NOT supported by the bullets: ${feedback}\n` +
        `Rewrite using ONLY the bullets above — no new numbers, names, or scope.\n\n`
      : "") +
    "Write ONE paragraph.";

  let feedback: string | undefined;
  let lastCheck: LedgerCheckResult | null = null;
  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    let paragraph: string;
    try {
      const out = await client.complete(buildPrompt(feedback), {
        system: SUMMARY_SYSTEM,
        maxTokens: 512,
        feature: "experience-summary",
      });
      paragraph = (out.text ?? "").trim();
    } catch {
      return gatedFallback("LLM request failed; used the role's verbatim bullets");
    }
    if (!paragraph) {
      feedback = "the output was empty";
      continue;
    }
    const check = await verifier.verify(paragraph, ledger);
    lastCheck = check;
    if (check.passed) return { ...base, paragraph, ok: true, check };
    feedback = offendingSentences(check);
  }

  // Every attempt introduced unsupported claims. Never surface a fabricated paragraph — fall back to
  // the verbatim bullets (gated), and only give up entirely if even those fail.
  const fallback = await gatedFallback("summary attempts introduced unsupported claims; used verbatim bullets");
  return fallback.ok ? fallback : { ...base, paragraph: null, ok: false, check: lastCheck, reason: "could not produce a summary that passes the ledger check" };
}
