// src/llm/capabilities.ts
//
// The single module that answers "which model handles feature X for this tier?" (commercial M3).
// Before this, AI features were gated by scattered preferLlm/useLlm/useLlmMatcher booleans that
// defaulted to false and were never set by the app's server paths — the flagship features (job
// rerank, LLM documents) were unreachable. Now: a feature is ON whenever the active provider can
// actually serve it, and OFF with a reason otherwise. Every consumer still fails soft to its
// deterministic fallback if a call errors at runtime.
//
// Tiers: today there is one (free = the local provider, embedded by default). Per-feature routing
// changes in ONE place, not eight.

import { getLlmClient } from "./client";
import { loadLlmConfig } from "./config";
import { allModelsPresent } from "./model-store";

export type AiFeature =
  | "resume-parse"
  | "structured-parse"
  | "job-rerank"
  | "doc-generation"
  | "ledger-judge"
  | "field-match"
  | "target-suggest"
  | "open-targets";

export interface AiCapability {
  enabled: boolean;
  /** Present when disabled — a plain-language reason surfaced by status endpoints. */
  reason?: string;
}

export function aiCapability(feature: AiFeature): AiCapability {
  const config = loadLlmConfig();
  if (!config) return { enabled: false, reason: "no AI model configured" };

  if (!getLlmClient()) return { enabled: false, reason: "no AI model configured" };
  if (config.provider === "embedded" && !allModelsPresent()) {
    return { enabled: false, reason: "bundled AI models not downloaded yet" };
  }
  return { enabled: true };
}

export function aiEnabled(feature: AiFeature): boolean {
  return aiCapability(feature).enabled;
}
