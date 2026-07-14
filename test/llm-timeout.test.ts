import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LLM_TIMEOUT_MS, resolveLlmTimeoutMs, withLlmTimeout } from "../src/llm/types";

describe("resolveLlmTimeoutMs", () => {
  const original = process.env.APPLYPILOT_LLM_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.APPLYPILOT_LLM_TIMEOUT_MS;
    else process.env.APPLYPILOT_LLM_TIMEOUT_MS = original;
  });

  it("prefers a valid explicit override", () => {
    expect(resolveLlmTimeoutMs(1234)).toBe(1234);
  });

  it("ignores non-positive overrides and falls back to the env var", () => {
    process.env.APPLYPILOT_LLM_TIMEOUT_MS = "5000";
    expect(resolveLlmTimeoutMs(0)).toBe(5000);
    expect(resolveLlmTimeoutMs(-1)).toBe(5000);
  });

  it("falls back to the default when nothing is configured", () => {
    delete process.env.APPLYPILOT_LLM_TIMEOUT_MS;
    expect(resolveLlmTimeoutMs()).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });
});

describe("withLlmTimeout", () => {
  it("returns the result when the work finishes in time", async () => {
    const out = await withLlmTimeout(1000, "fast", async () => "ok");
    expect(out).toBe("ok");
  });

  it("aborts the signal and throws a labeled timeout when the work stalls", async () => {
    let aborted = false;
    const promise = withLlmTimeout(20, "Local LLM (test)", (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      // Ignores the signal deliberately — the race must still time out.
      return new Promise<string>((resolve) => setTimeout(() => resolve("late"), 1000));
    });
    await expect(promise).rejects.toThrow(/Local LLM \(test\) timed out after 20ms/);
    expect(aborted).toBe(true);
  });

  it("propagates a non-timeout error unchanged", async () => {
    await expect(withLlmTimeout(1000, "x", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });
});
