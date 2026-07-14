// The POST /api/settings body builder (extracted from SettingsView.save for testability, commercial
// M10). The save is otherwise a thin fetch; the real logic is here: which optional keys we persist.
// Two rules worth pinning against regressions:
//   1. llmBaseUrl is only sent for local HTTP providers — never for `anthropic`/`embedded`, where a
//      stale localhost URL would misroute a client that honors it.
//   2. Every credential/hint field is trimmed and omitted entirely when blank, so saving an unrelated
//      setting never blanks a stored key server-side.

/** The trimmed-or-not form field values SettingsView holds in state. */
export interface SettingsFormFields {
  llmProvider: string;
  llmModel: string;
  llmBaseUrl: string;
  llmApiKey: string;
  maxAgeDays: number;
  adzunaAppId: string;
  adzunaAppKey: string;
  joobleKey: string;
  usajobsKey: string;
  usajobsEmail: string;
}

export function buildSettingsPayload(f: SettingsFormFields): Record<string, unknown> {
  return {
    llmProvider: f.llmProvider,
    llmModel: f.llmModel,
    // Base URL only applies to local HTTP providers — never persist a stale localhost URL for
    // anthropic/embedded (it would misroute clients that honor it).
    ...(f.llmBaseUrl.trim() && f.llmProvider !== "anthropic" && f.llmProvider !== "embedded"
      ? { llmBaseUrl: f.llmBaseUrl.trim() }
      : {}),
    ...(f.llmApiKey.trim() ? { llmApiKey: f.llmApiKey.trim() } : {}),
    maxAgeDays: f.maxAgeDays,
    ...(f.adzunaAppId.trim() ? { adzunaAppId: f.adzunaAppId.trim() } : {}),
    ...(f.adzunaAppKey.trim() ? { adzunaAppKey: f.adzunaAppKey.trim() } : {}),
    ...(f.joobleKey.trim() ? { joobleKey: f.joobleKey.trim() } : {}),
    ...(f.usajobsKey.trim() ? { usajobsKey: f.usajobsKey.trim() } : {}),
    ...(f.usajobsEmail.trim() ? { usajobsEmail: f.usajobsEmail.trim() } : {}),
  };
}
