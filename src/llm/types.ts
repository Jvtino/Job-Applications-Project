// Shared LLM client interface used by parsing, generation, and field matching.

export interface LlmCompleteOptions {
  system?: string;
  maxTokens?: number;
  /** Abort the request after this many ms. Defaults to resolveLlmTimeoutMs(). */
  timeoutMs?: number;
  /** Which product feature is asking (metering attribution, e.g. "job-rerank"). */
  feature?: string;
}

/** Token counts as reported by the provider; absent when the provider doesn't report them. */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A completion result. `usage` powers the metered paid tier (commercial M3+): every provider that
 * knows its token counts reports them, and callers read `.text`. `cached` marks responses served
 * from a cache (local llm_cache today; the proxy's server-side cache later) — cached calls must
 * never be billed.
 */
export interface LlmCompletion {
  text: string;
  usage?: LlmUsage;
  cached?: boolean;
}

export interface LlmClient {
  model: string;
  provider: string;
  /** Runs a single user prompt and returns the completion (text + usage metadata). */
  complete(prompt: string, opts?: LlmCompleteOptions): Promise<LlmCompletion>;
}

// ---- Usage metering sink ----------------------------------------------------------------------
// The LLM layer stays storage-agnostic: providers report events here, and the API server installs
// a sink that persists them (llm_usage table). No prompt or completion text ever enters an event.

export interface LlmUsageEvent {
  provider: string;
  model: string;
  feature: string;
  inputTokens?: number;
  outputTokens?: number;
  cached: boolean;
}

let usageSink: ((event: LlmUsageEvent) => void) | null = null;

export function setLlmUsageSink(sink: ((event: LlmUsageEvent) => void) | null): void {
  usageSink = sink;
}

/** Fire-and-forget: metering must never break a completion. */
export function recordLlmUsage(event: LlmUsageEvent): void {
  try {
    usageSink?.(event);
  } catch {
    /* metering is best-effort */
  }
}

/** Default per-request LLM timeout (ms). Override with APPLYPILOT_LLM_TIMEOUT_MS. */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

export function resolveLlmTimeoutMs(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override > 0) return override;
  const raw = Number(process.env.APPLYPILOT_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_TIMEOUT_MS;
}

/**
 * Run `fn(signal)` with an abort timer so a stalled local model can't hang the request for the full
 * undici default (~5 min). On timeout the error is normalized to a clear, catchable message so
 * callers can fall back to the deterministic path.
 */
export async function withLlmTimeout<T>(timeoutMs: number, label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(); // cancel the in-flight request (frees the socket)
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    // Race the work against the timer so we still resolve even if `fn` ignores the abort signal.
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pull the first JSON value (object or array) out of a model response. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in model response.");
  const open = candidate[start]!;
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error("Unbalanced JSON in model response.");
}
