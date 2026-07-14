// Settings POST body builder (commercial M10). Pins the two rules that keep a save from misrouting a
// client or blanking a stored credential: llmBaseUrl is provider-gated, and blank fields are omitted.
import { describe, it, expect } from "vitest";
import { buildSettingsPayload, type SettingsFormFields } from "./settings-payload";

const base: SettingsFormFields = {
  llmProvider: "ollama",
  llmModel: "qwen2.5:7b",
  llmBaseUrl: "http://127.0.0.1:11434",
  llmApiKey: "",
  maxAgeDays: 30,
  adzunaAppId: "",
  adzunaAppKey: "",
  joobleKey: "",
  usajobsKey: "",
  usajobsEmail: "",
};

describe("buildSettingsPayload", () => {
  it("always includes provider, model, and maxAgeDays", () => {
    const p = buildSettingsPayload(base);
    expect(p).toMatchObject({ llmProvider: "ollama", llmModel: "qwen2.5:7b", maxAgeDays: 30 });
  });

  it("sends a trimmed llmBaseUrl for local HTTP providers", () => {
    const p = buildSettingsPayload({ ...base, llmProvider: "openai-compatible", llmBaseUrl: "  http://host:1234  " });
    expect(p.llmBaseUrl).toBe("http://host:1234");
  });

  it("omits llmBaseUrl for anthropic and embedded even when one is set", () => {
    for (const provider of ["anthropic", "embedded"]) {
      const p = buildSettingsPayload({ ...base, llmProvider: provider, llmBaseUrl: "http://stale.localhost" });
      expect(p).not.toHaveProperty("llmBaseUrl");
    }
  });

  it("omits llmBaseUrl when blank/whitespace regardless of provider", () => {
    const p = buildSettingsPayload({ ...base, llmBaseUrl: "   " });
    expect(p).not.toHaveProperty("llmBaseUrl");
  });

  it("omits every blank credential/hint field so an unrelated save never blanks a stored key", () => {
    const p = buildSettingsPayload(base);
    for (const k of ["llmApiKey", "adzunaAppId", "adzunaAppKey", "joobleKey", "usajobsKey", "usajobsEmail"]) {
      expect(p).not.toHaveProperty(k);
    }
  });

  it("includes and trims the credential fields that are provided", () => {
    const p = buildSettingsPayload({
      ...base,
      llmApiKey: "  sk-abc  ",
      adzunaAppId: " id ",
      adzunaAppKey: " key ",
      joobleKey: " jk ",
      usajobsKey: " uk ",
      usajobsEmail: " me@example.com ",
    });
    expect(p).toMatchObject({
      llmApiKey: "sk-abc",
      adzunaAppId: "id",
      adzunaAppKey: "key",
      joobleKey: "jk",
      usajobsKey: "uk",
      usajobsEmail: "me@example.com",
    });
  });
});
