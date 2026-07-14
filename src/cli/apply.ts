// src/cli/apply.ts
//
// `npm run apply -- --url <greenhouse-url> [--mode semi_auto] [--company X] [--title Y]
//                   [--resume <path>] [--cover <path>] [--headless] [--llm-matcher]`
//
// Opens the employer's Greenhouse application page in a HEADED browser (default), fills it per
// the risk policy, and PAUSES at the review gate. ApplyPilot does not submit — after reviewing,
// you click submit yourself in the open browser window. On a CAPTCHA/login wall it stops and
// hands the browser to you.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { BrowserSession } from "../ats/browser";
import { runApplication, UnsupportedAtsError } from "../orchestrator/apply";
import { renderReviewGate } from "../orchestrator/review-gate";
import { DuplicateApplicationError, RateLimitedError } from "../db/applications-repo";
import type { OperatingMode } from "../ats/adapter";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = flag(args, "--url");
  if (!url) {
    process.stderr.write(
      'Usage: npm run apply -- --url <greenhouse-url> [--mode semi_auto] [--company X] [--title Y] [--resume <path>] [--cover <path>] [--headless] [--llm-matcher] [--account-mode prefill|handoff|off] [--password-store "1Password"]\n'
    );
    process.exitCode = 1;
    return;
  }
  const mode = (flag(args, "--mode") as OperatingMode | undefined) ?? "semi_auto";
  const headed = !args.includes("--headless");

  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const profile = resolveActiveProfile(new ProfileRepo(db, cfg.encryptionKey), { demoMode: cfg.demoMode });
  if (!profile) {
    process.stderr.write("No profile found. Run `npm run setup` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }

  const session = new BrowserSession({ headed });
  await session.start();
  try {
    const outcome = await runApplication(session, db, {
      url,
      mode,
      profile,
      ...(flag(args, "--company") ? { company: flag(args, "--company")! } : {}),
      ...(flag(args, "--title") ? { title: flag(args, "--title")! } : {}),
      ...(flag(args, "--resume") ? { resumePath: flag(args, "--resume")! } : {}),
      ...(flag(args, "--cover") ? { coverLetterPath: flag(args, "--cover")! } : {}),
      useLlmMatcher: args.includes("--llm-matcher"),
      accountMode: (flag(args, "--account-mode") as "prefill" | "handoff" | "off" | undefined) ?? "prefill",
      ...(flag(args, "--password-store") ? { passwordStore: flag(args, "--password-store")! } : {}),
    });

    if (outcome.accountRequired) {
      stdout.write(
        "\nThis site needs an account. ApplyPilot pre-filled the non-secret fields and (if a new\n" +
          "account) put a strong password on your clipboard. Set the password + create/sign in\n" +
          "yourself, then re-run apply for this URL.\n"
      );
    }

    renderReviewGate(outcome.gate);

    if (headed) {
      stdout.write(
        "\nThe browser is open and paused. Review the form, fix any flagged/needed fields,\n" +
          "then SUBMIT yourself. ApplyPilot will not submit for you.\n"
      );
      const rl = createInterface({ input: stdin, output: stdout });
      await rl.question("Press Enter here to close the browser when you're done... ");
      rl.close();
    }
  } catch (err) {
    if (err instanceof DuplicateApplicationError) process.stderr.write(`Skipped: ${err.message}\n`);
    else if (err instanceof RateLimitedError) process.stderr.write(`Skipped: ${err.message}\n`);
    else if (err instanceof UnsupportedAtsError) process.stderr.write(`${err.message}\n`);
    else throw err;
    process.exitCode = 1;
  } finally {
    await session.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error("apply failed:", err);
  process.exitCode = 1;
});
