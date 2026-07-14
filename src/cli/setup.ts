// src/cli/setup.ts
//
// `npm run setup` — first-run (and re-run/edit) of the profile wizard. Single-user: edits the
// active live profile if present, otherwise creates one.

import { loadConfig } from "../config";
import { getDatabase, closeDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { createBlankProfile } from "../profile/factory";
import { resolveActiveProfile } from "../profile/active-profile";
import { runSetupWizard } from "../profile/wizard";
import { Prompter } from "./prompt";

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.encryptionKey) {
    process.stdout.write(
      "WARNING: APPLYPILOT_ENCRYPTION_KEY is not set — your profile (including sensitive\n" +
        "self-ID data) will be stored UNENCRYPTED at rest. Set a key in .env to encrypt it.\n\n"
    );
  }
  const db = getDatabase(cfg.dbPath);
  const repo = new ProfileRepo(db, cfg.encryptionKey);

  const existing = resolveActiveProfile(repo, { demoMode: cfg.demoMode });
  const base = existing ?? createBlankProfile();
  if (existing) {
    process.stdout.write("Existing profile found — editing it (press Enter to keep a value).\n");
  }

  const p = new Prompter();
  try {
    const profile = await runSetupWizard(p, base);
    const saved = repo.save(profile);
    process.stdout.write(`Saved profile ${saved.id}.\n`);
    process.stdout.write(`Datastore: ${cfg.dbPath}\n`);
  } finally {
    p.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exitCode = 1;
});
