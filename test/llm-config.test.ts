import { afterEach, describe, it, expect, vi } from "vitest";
import { loadLlmConfig, parseLlmProvider, isLlmConfigured } from "../src/llm/config";
import { createOpenAiCompatibleClient } from "../src/llm/openai-compatible";
import { resetLlmClientCache, getLlmClient } from "../src/llm/client";

describe("llm-config", () => {
  it("defaults to the bundled embedded provider without any anthropic key", () => {
    const cfg = loadLlmConfig();
    expect(cfg?.provider).toBe("embedded");
    expect(cfg?.model).toBe("qwen2.5-1.5b-instruct");
    expect(cfg?.baseUrl).toBe(""); // in-process — no HTTP endpoint
    expect(isLlmConfigured(cfg)).toBe(true);
  });

  it("parses provider aliases", () => {
    expect(parseLlmProvider("embedded")).toBe("embedded");
    expect(parseLlmProvider("bundled")).toBe("embedded");
    expect(parseLlmProvider("local")).toBe("ollama");
    expect(parseLlmProvider("vllm")).toBe("openai-compatible");
    expect(parseLlmProvider("claude")).toBe("anthropic");
    expect(parseLlmProvider("something-unknown")).toBe("embedded"); // unknown -> safe default
  });

  it("still resolves ollama when explicitly selected", () => {
    const cfg = loadLlmConfig({ provider: "ollama" });
    expect(cfg?.provider).toBe("ollama");
    expect(cfg?.baseUrl).toContain("11434");
    expect(isLlmConfigured(cfg)).toBe(true);
  });
});

describe("openai-compatible client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLlmClientCache();
  });

  it("calls /chat/completions and returns assistant text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] }),
    } as Response);

    const client = createOpenAiCompatibleClient({
      provider: "ollama",
      model: "gemma4:e4b",
      baseUrl: "http://localhost:11434/v1",
    });
    const completion = await client.complete("ping");
    expect(completion.text).toBe("hello");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("getLlmClient returns the embedded client by default", () => {
    resetLlmClientCache();
    const client = getLlmClient();
    expect(client?.provider).toBe("embedded");
  });
});

describe("embedded provider without downloaded models", () => {
  it("fails fast with a clear model-not-downloaded error (callers fall back deterministically)", async () => {
    const { createEmbeddedClient, ModelNotDownloadedError } = await import("../src/llm/embedded");
    const prev = process.env.APPLYPILOT_MODELS_DIR;
    process.env.APPLYPILOT_MODELS_DIR = "/nonexistent/applypilot-models";
    try {
      const client = createEmbeddedClient();
      await expect(client.complete("ping")).rejects.toThrow(ModelNotDownloadedError);
    } finally {
      prev === undefined ? delete process.env.APPLYPILOT_MODELS_DIR : (process.env.APPLYPILOT_MODELS_DIR = prev);
    }
  });
});
