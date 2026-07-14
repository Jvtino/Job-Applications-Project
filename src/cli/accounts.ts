// src/cli/accounts.ts
//
// `npm run accounts` — list the career sites that require an account and their session state.
// METADATA ONLY (no passwords): which sites you have an account on, the email/username you use,
// where you saved the password, and whether the persistent browser session is currently logged
// in (so auto mode can reuse it) or needs a one-time login from you.

import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { AccountsRepo } from "../db/accounts-repo";
import { resolveActiveProfile } from "../profile/active-profile";

function main(): void {
  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const profile = resolveActiveProfile(new ProfileRepo(db, cfg.encryptionKey), { demoMode: cfg.demoMode });
  if (!profile) {
    process.stderr.write("No profile found. Run `npm run setup` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }
  const accounts = new AccountsRepo(db).list(profile.id);
  if (!accounts.length) {
    process.stdout.write("No account-gated sites recorded yet.\n");
    closeDatabase();
    return;
  }
  process.stdout.write("Career-site accounts (metadata only — ApplyPilot stores no passwords):\n\n");
  for (const a of accounts) {
    const state = a.loggedIn ? "✅ logged in (auto-ready)" : "🔑 needs login";
    process.stdout.write(
      `  ${state}  ${a.domain}\n` +
        `      username: ${a.username ?? "—"}   password saved in: ${a.passwordStore ?? "—"}\n` +
        (a.lastLoginAt ? `      last login: ${a.lastLoginAt}\n` : "")
    );
  }
  process.stdout.write(
    "\nLog in once in the headed browser during `npm run apply`; the session persists in the\n" +
      "browser profile, so future runs (incl. auto mode) reuse it. No password is ever stored.\n"
  );
  closeDatabase();
}

main();
