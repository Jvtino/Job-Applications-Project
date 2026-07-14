// OpenAI-compatible chat completions (Ollama, LocalAI, vLLM, LM Studio, etc.).

import { type LlmClient, recordLlmUsage, resolveLlmTimeoutMs, withLlmTimeout } from "./types";
import type { LlmConfig } from "./config";

export function createOpenAiCompatibleClient(config: LlmConfig): LlmClient {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return {
    model: config.model,
    provider: config.provider,
    async complete(prompt, opts = {}) {
      const timeoutMs = resolveLlmTimeoutMs(opts.timeoutMs);
      // The whole request — including reading the body — runs under the abort signal. With
      // stream:false, Ollama returns 200 headers immediately and holds the body until generation
      // finishes (can be very slow on CPU), so timing out only the fetch (not res.json()) would
      // still hang; doing the body read inside the wrapper lets the abort interrupt it.
      return withLlmTimeout(timeoutMs, `Local LLM (${config.model})`, async (signal) => {
        const res = await fetch(url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: opts.maxTokens ?? 4096,
            stream: false,
            messages: [
              ...(opts.system ? [{ role: "system", content: opts.system }] : []),
              { role: "user", content: prompt },
            ],
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 200)}`);
        }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          error?: { message?: string };
        };
        if (body.error?.message) throw new Error(body.error.message);
        const text = body.choices?.[0]?.message?.content;
        if (!text) throw new Error("Empty response from local LLM");
        const usage = {
          ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
          ...(body.usage?.completion_tokens !== undefined ? { outputTokens: body.usage.completion_tokens } : {}),
        };
        recordLlmUsage({
          provider: config.provider,
          model: config.model,
          feature: opts.feature ?? "unknown",
          ...usage,
          cached: false,
        });
        return { text, usage };
      });
    },
  };
}
