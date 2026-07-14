// Anthropic Claude API (optional cloud provider).

import Anthropic from "@anthropic-ai/sdk";
import { type LlmClient, recordLlmUsage, resolveLlmTimeoutMs, withLlmTimeout } from "./types";
import type { LlmConfig } from "./config";

export function createAnthropicClient(config: LlmConfig): LlmClient {
  if (!config.apiKey) throw new Error("Anthropic provider requires an API key");
  // Pass baseURL only when it differs from Anthropic's own endpoint (a gateway/proxy override via
  // APPLYPILOT_ANTHROPIC_BASE_URL). Omitting it for the default keeps the SDK's own
  // ANTHROPIC_BASE_URL env-var support working exactly as before.
  const baseURL = config.baseUrl && config.baseUrl !== "https://api.anthropic.com" ? config.baseUrl : undefined;
  const client = new Anthropic({ apiKey: config.apiKey, ...(baseURL ? { baseURL } : {}) });
  return {
    model: config.model,
    provider: "anthropic",
    async complete(prompt, opts = {}) {
      const timeoutMs = resolveLlmTimeoutMs(opts.timeoutMs);
      const res = await withLlmTimeout(timeoutMs, `Anthropic (${config.model})`, (signal) =>
        client.messages.create(
          {
            model: config.model,
            max_tokens: opts.maxTokens ?? 4096,
            ...(opts.system ? { system: opts.system } : {}),
            messages: [{ role: "user", content: prompt }],
          },
          { signal }
        )
      );
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const usage = {
        ...(res.usage?.input_tokens !== undefined ? { inputTokens: res.usage.input_tokens } : {}),
        ...(res.usage?.output_tokens !== undefined ? { outputTokens: res.usage.output_tokens } : {}),
      };
      recordLlmUsage({
        provider: "anthropic",
        model: config.model,
        feature: opts.feature ?? "unknown",
        ...usage,
        cached: false,
      });
      return { text, usage };
    },
  };
}
