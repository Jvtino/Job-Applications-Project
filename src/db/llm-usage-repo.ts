// src/db/llm-usage-repo.ts
//
// Append-only LLM usage ledger (commercial M3). Events carry provider/model/feature/token counts
// only — never prompt or completion text, never PII. The paid tier's usage display (M6) and
// billing reconciliation (M5) read from here; the free tier uses it for the local usage view.

import type { DB } from "./database";
import type { LlmUsageEvent } from "../llm/types";

export interface LlmUsageTotals {
  calls: number;
  cachedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export class LlmUsageRepo {
  constructor(private readonly db: DB) {}

  record(event: LlmUsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO llm_usage (ts, provider, model, feature, input_tokens, output_tokens, cached)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        event.provider,
        event.model,
        event.feature,
        event.inputTokens ?? null,
        event.outputTokens ?? null,
        event.cached ? 1 : 0
      );
  }

  /** Totals since the given ISO timestamp (defaults to the last 30 days). */
  totalsSince(sinceIso?: string): LlmUsageTotals {
    const since = sinceIso ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(cached), 0) AS cachedCalls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM llm_usage WHERE ts >= ?`
      )
      .get(since) as { calls: number; cachedCalls: number; inputTokens: number; outputTokens: number };
    return row;
  }

  /** Per-feature rollup for the usage view. */
  byFeatureSince(sinceIso?: string): Array<{ feature: string; calls: number; inputTokens: number; outputTokens: number }> {
    const since = sinceIso ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT feature,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM llm_usage WHERE ts >= ? GROUP BY feature ORDER BY calls DESC`
      )
      .all(since) as Array<{ feature: string; calls: number; inputTokens: number; outputTokens: number }>;
  }
}
