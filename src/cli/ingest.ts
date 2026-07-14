// src/cli/ingest.ts
//
// `npm run ingest -- <path-to-resume>` — Module 2 entry point.
//   1. extract text (PDF/DOCX/TXT)
//   2. parse into candidate facts (heuristic offline, or LLM with --llm)
//   3. extract role/location/comp DEFAULTS and confirm them (brief §7)
//   4. review/approve the ledger
//   5. persist the ledger + point the profile at the master resume

import { resolve } from "node:path";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase, recordAudit } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { createBlankProfile } from "../profile/factory";
import { resolveActiveProfile } from "../profile/active-profile";
import { upsertDynamicAnswer } from "../profile/dynamic-qa";
import { extractResumeText } from "../ingestion/extract-text";
import { parseResume } from "../ingestion/parse-resume";
import { extractDefaults } from "../ingestion/extract-defaults";
import { buildLedger } from "../ingestion/ledger-ops";
import { reviewLedgerInteractive } from "../ingestion/ledger-review";
import { Prompter } from "./prompt";
import type { ApplicantProfile } from "../types/applicant-profile";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const preferLlm = args.includes("--llm");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    process.stderr.write("Usage: npm run ingest -- <path-to-resume.(pdf|docx|txt)> [--llm]\n");
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const profileRepo = new ProfileRepo(db, cfg.encryptionKey);
  const ledgerRepo = new LedgerRepo(db, cfg.encryptionKey);

  // Single-user: attach to the active live profile, or create a placeholder one.
  const existing = resolveActiveProfile(profileRepo, { demoMode: cfg.demoMode });
  let profile: ApplicantProfile = existing ?? createBlankProfile();
  const isNew = !existing;

  const p = new Prompter();
  try {
    p.print(`Extracting text from ${path} ...`);
    const extracted = await extractResumeText(resolve(path));
    p.print(`Got ${extracted.text.length} chars (${extracted.format}).`);

    p.print(`Parsing resume (${preferLlm ? "LLM if available" : "heuristic"}) ...`);
    const parsed = await parseResume(extracted.text, { preferLlm });
    parsed.warnings.forEach((w) => p.print(`  ! ${w}`));
    p.print(`Parsed ${parsed.facts.length} candidate fact(s) via ${parsed.method}.`);

    // --- §7 defaults: extract + confirm ---
    const defaults = extractDefaults(parsed.facts, extracted.text);
    profile = await confirmDefaults(p, profile, defaults);

    // --- review/approve ledger ---
    let ledger = buildLedger(profile.id, parsed.facts);
    ledger = await reviewLedgerInteractive(p, ledger);

    // --- persist ---
    profile.masterResumePath = resolve(path);
    profile.updatedAt = new Date().toISOString();
    profileRepo.save(profile);
    ledgerRepo.save(ledger);
    recordAudit(db, profile.id, "resume.ingest", {
      path: profile.masterResumePath,
      method: parsed.method,
      facts: ledger.facts.length,
      approved: ledger.facts.filter((f) => f.approved).length,
    });

    p.print(`\nSaved ledger for profile ${profile.id}${isNew ? " (new profile created)" : ""}.`);
    if (isNew) p.print("Tip: run `npm run setup` to complete your profile (contact, work auth, self-ID).");
  } finally {
    p.close();
    closeDatabase();
  }
}

async function confirmDefaults(
  p: Prompter,
  profile: ApplicantProfile,
  defaults: ReturnType<typeof extractDefaults>
): Promise<ApplicantProfile> {
  p.print("\n--- Extracted defaults (please confirm) ---");
  p.print(`Target roles:  ${defaults.targetRoles.join(", ") || "(none detected)"}`);
  p.print(`Locations:     ${defaults.locations.join(", ") || "(none detected)"}`);
  p.print(
    `Compensation:  ${
      defaults.compensation
        ? `${defaults.compensation.min ?? "?"} - ${defaults.compensation.max ?? "?"} USD`
        : "(none detected)"
    }`
  );

  if (defaults.targetRoles.length && (await p.confirm("Save these target roles?", true))) {
    profile.preferences.targetRoles = defaults.targetRoles;
    profile.dynamicAnswers = upsertDynamicAnswer(profile.dynamicAnswers, {
      questionText: "What roles are you targeting?",
      fieldType: "multi_select",
      answer: defaults.targetRoles,
    });
  }
  if (defaults.locations.length && (await p.confirm("Use these as desired locations?", true))) {
    profile.preferences.desiredLocations = defaults.locations;
  }
  if (
    defaults.compensation &&
    (await p.confirm("Use this as your desired compensation range?", false))
  ) {
    if (defaults.compensation.min !== undefined)
      profile.preferences.compensation.desiredBaseMin = defaults.compensation.min;
    if (defaults.compensation.max !== undefined)
      profile.preferences.compensation.desiredBaseMax = defaults.compensation.max;
  }
  return profile;
}

main().catch((err) => {
  console.error("Ingest failed:", err);
  process.exitCode = 1;
});
