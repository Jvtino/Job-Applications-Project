// src/generation/ledger-verifier.ts
//
// Concrete LedgerVerifier — the anti-fabrication core. Order of operations matters:
//
//   1. DETERMINISTIC GATE (always): decompose the document into claims; every number, year,
//      and proper-noun/organization entity in a claim MUST trace to an approved fact. Any
//      that doesn't makes the claim unsupported, which makes the whole result fail.
//   2. OPTIONAL LLM JUDGE: only runs on claims that already PASSED the gate, and can only
//      DOWNGRADE them (flag an unfaithful paraphrase). It can never bless a claim the gate
//      rejected. An LLM "looks fine" therefore never overrides a failed deterministic check.
//
// "Err toward flagging — a false positive is cheap; a fabricated credential is not."

import type { Fact, FactsLedger } from "../types/facts-ledger";
import type { Claim, ClaimCheck, LedgerCheckResult, LedgerVerifier } from "./ledger-check";
import {
  extractClaims,
  extractEntities,
  extractNumbers,
  normalizeForMatch,
  significantTokens,
} from "./claim-extraction";
import { getLlmClient, extractJson, type LlmClient } from "../llm/anthropic";

// ---------------------------------------------------------------------------------------
// Support index built from the APPROVED subset of the ledger.
// ---------------------------------------------------------------------------------------

interface SupportIndex {
  corpus: string; // normalized concatenation of all approved-fact text
  tokens: Set<string>; // tokens (len >= 2) from the corpus, incl. acronyms
  numbers: Set<string>; // every numeric value asserted by an approved fact
  facts: { fact: Fact; normalized: string }[];
}

function factText(fact: Fact): string {
  switch (fact.type) {
    case "employment":
      return [fact.title, fact.employer, fact.location ?? "", fact.startDate, fact.endDate, ...fact.bullets].join(" ");
    case "education":
      return [fact.degree, fact.field ?? "", fact.institution, fact.graduationDate ?? ""].join(" ");
    case "certification":
      return [fact.name, fact.issuer ?? "", fact.dateEarned ?? ""].join(" ");
    case "metric":
      return [fact.statement, fact.value ?? "", fact.unit ?? ""].join(" ");
    default:
      return fact.statement;
  }
}

function buildSupportIndex(ledger: FactsLedger, allowlist: string[]): SupportIndex {
  const approved = ledger.facts.filter((f) => f.approved);
  const facts = approved.map((fact) => ({ fact, normalized: normalizeForMatch(factText(fact)) }));
  const allowNorm = allowlist.map(normalizeForMatch).filter(Boolean);
  const corpus = [...facts.map((f) => f.normalized), ...allowNorm].join("  ");

  const tokens = new Set<string>();
  for (const t of corpus.split(" ")) if (t.length >= 2) tokens.add(t);

  const numbers = new Set<string>();
  for (const { fact } of facts) {
    for (const n of extractNumbers(factText(fact))) numbers.add(n);
  }
  // Allowlist numbers count as supported too (e.g., a known job-req number).
  for (const a of allowlist) for (const n of extractNumbers(a)) numbers.add(n);

  return { corpus, tokens, numbers, facts };
}

// ---------------------------------------------------------------------------------------
// Deterministic per-claim check.
// ---------------------------------------------------------------------------------------

function entitySupported(entity: string, index: SupportIndex): boolean {
  const norm = normalizeForMatch(entity);
  if (!norm) return true;
  const words = norm.split(" ").filter(Boolean);
  if (words.length === 1) {
    return index.tokens.has(words[0]!);
  }
  // Multi-word: the phrase must appear verbatim, OR every significant token is present.
  if (index.corpus.includes(norm)) return true;
  const sig = words.filter((w) => w.length > 2);
  return sig.length > 0 && sig.every((w) => index.tokens.has(w));
}

function bestSupportingFact(claim: Claim, index: SupportIndex): string | undefined {
  const claimTokens = new Set(significantTokens(claim.text));
  if (claimTokens.size === 0) return index.facts[0]?.fact.id;
  let bestId: string | undefined;
  let bestScore = 0;
  for (const { fact, normalized } of index.facts) {
    const factToks = new Set(normalized.split(" "));
    let score = 0;
    for (const t of claimTokens) if (factToks.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestId = fact.id;
    }
  }
  return bestScore > 0 ? bestId : undefined;
}

// Verbs/phrases that ASSERT accomplishment, ownership, leadership, or scope — the sentences a
// fabricated résumé/cover letter inflates. Kept to genuine scope claims (NOT generic connective
// verbs like "apply", "welcome", "discuss") so truthful boilerplate is never flagged; a claim of
// this kind must trace to an approved fact even when it carries no number or named entity.
const ACCOMPLISHMENT_CLAIM =
  /\b(led|leading|managed|managing|oversaw|overseeing|supervised|supervising|directed|directing|headed|heading|spearheaded|spearheading|orchestrated|championed|owned|owning|founded|co-?founded|established|establishing|ran|running|built and (?:led|ran)|scaled|scaling|grew|growing|mentored|mentoring|coached|coaching|hired|architected|pioneered)\b|\b(responsible for|in charge of|ownership of|oversight of|leadership of|reporting to me|reported to me|led a team|managed a team|team of \d)\b/i;

function deterministicCheck(claim: Claim, index: SupportIndex): ClaimCheck {
  const problems: string[] = [];

  for (const n of extractNumbers(claim.text)) {
    if (!index.numbers.has(n)) {
      problems.push(`number "${n}" is not asserted by any approved fact`);
    }
  }
  for (const e of extractEntities(claim.text)) {
    if (!entitySupported(e, index)) {
      problems.push(`named entity "${e}" does not match any approved fact`);
    }
  }

  const supportingFactId = bestSupportingFact(claim, index);

  // A7: close the gap where a claim carries NO number and NO named entity but still ASSERTS an
  // accomplishment/ownership/scope that no approved fact backs (e.g. "Owned the compliance program",
  // "Led company-wide transformation"). Every such claim must trace to an approved fact by content
  // overlap — the LLM judge can only downgrade, never rescue, so this is the deterministic floor.
  if (problems.length === 0 && !supportingFactId && ACCOMPLISHMENT_CLAIM.test(claim.text)) {
    problems.push("claim asserts experience/ownership/leadership not traceable to any approved fact");
  }

  if (problems.length > 0) {
    return {
      claim,
      supported: false,
      reason: `deterministic gate: ${problems.join("; ")}`,
    };
  }
  return {
    claim,
    supported: true,
    ...(supportingFactId ? { supportingFactId } : {}),
    reason: "deterministic gate: numbers, named entities, and asserted experience trace to approved facts",
  };
}

// ---------------------------------------------------------------------------------------
// Verifier implementations.
// ---------------------------------------------------------------------------------------

export interface VerifierOptions {
  /** Legitimate non-ledger entities/numbers (e.g., the target employer in a cover letter). */
  allowlist?: string[];
  /** Opt into the LLM paraphrase judge (only downgrades; requires an API key). */
  useLlm?: boolean;
}

export class DeterministicLedgerVerifier implements LedgerVerifier {
  constructor(private readonly allowlist: string[] = []) {}

  async verify(documentText: string, ledger: FactsLedger): Promise<LedgerCheckResult> {
    const index = buildSupportIndex(ledger, this.allowlist);
    const checks = extractClaims(documentText).map((c) => deterministicCheck(c, index));
    return { passed: checks.every((c) => c.supported), checks };
  }
}

/**
 * Deterministic gate + LLM paraphrase judge. The judge sees only the claims that already
 * passed the gate and the approved facts, and may mark any of them unfaithful. Downgrades
 * only; it cannot rescue a claim the gate failed.
 */
export class LlmAugmentedLedgerVerifier implements LedgerVerifier {
  constructor(
    private readonly client: LlmClient,
    private readonly allowlist: string[] = []
  ) {}

  async verify(documentText: string, ledger: FactsLedger): Promise<LedgerCheckResult> {
    const index = buildSupportIndex(ledger, this.allowlist);
    const checks = extractClaims(documentText).map((c) => deterministicCheck(c, index));

    const passedIdx = checks.map((c, i) => (c.supported ? i : -1)).filter((i) => i >= 0);
    if (passedIdx.length > 0) {
      try {
        const downgrades = await this.judge(
          passedIdx.map((i) => checks[i]!.claim.text),
          index.facts.map((f) => f.fact)
        );
        downgrades.forEach((reason, localIdx) => {
          if (reason) {
            const globalIdx = passedIdx[localIdx]!;
            checks[globalIdx] = {
              ...checks[globalIdx]!,
              supported: false,
              reason: `${checks[globalIdx]!.reason} | LLM paraphrase judge: ${reason}`,
            };
          }
        });
      } catch {
        // Judge failure must never relax the result; keep the deterministic outcome.
      }
    }
    return { passed: checks.every((c) => c.supported), checks };
  }

  /** Returns, per passed-claim, a downgrade reason string or null (faithful). */
  private async judge(claims: string[], facts: Fact[]): Promise<(string | null)[]> {
    const factLines = facts
      .map((f, i) => `F${i}: ${factText(f)}`)
      .join("\n");
    const claimLines = claims.map((c, i) => `C${i}: ${c}`).join("\n");
    const system =
      "You are a strict fidelity checker for resume/cover-letter claims. A claim is FAITHFUL " +
      "only if it is fully supported by the listed facts with no exaggeration, invented detail, " +
      "or altered meaning. When unsure, mark it unfaithful. Output JSON only.";
    const prompt =
      `FACTS:\n${factLines}\n\nCLAIMS:\n${claimLines}\n\n` +
      `Return a JSON array of objects [{ "i": <claim index>, "faithful": <bool>, "reason": "<short>" }] ` +
      `covering every claim index.`;
    const out = await this.client.complete(prompt, { system, maxTokens: 2048, feature: "ledger-judge" });
    const parsed = extractJson(out.text) as { i: number; faithful: boolean; reason?: string }[];
    const result: (string | null)[] = claims.map(() => null);
    for (const r of parsed) {
      if (typeof r.i === "number" && r.i >= 0 && r.i < claims.length && r.faithful === false) {
        result[r.i] = r.reason || "judged unfaithful to the facts";
      }
    }
    return result;
  }
}

/** Pick the right verifier: LLM-augmented when requested AND a key is configured, else pure. */
export function createLedgerVerifier(opts: VerifierOptions = {}): LedgerVerifier {
  const allowlist = opts.allowlist ?? [];
  if (opts.useLlm) {
    const client = getLlmClient();
    if (client) return new LlmAugmentedLedgerVerifier(client, allowlist);
  }
  return new DeterministicLedgerVerifier(allowlist);
}
