// src/cli/autopilot.ts
//
// `npm run autopilot -- [--mode auto|semi] [--live-submit] [--min-score 0.75] [--max 10] [--headless]`
//
// One pass of the always-on loop. SAFE BY DEFAULT: mode=semi fills every match and queues it for
// your one-click review (submits nothing). To actually auto-submit you must opt in with BOTH
// `--mode auto` AND `--live-submit`, and only employers you've pre-approved
// (`npm run companies -- approve <id>`) and forms that clear every safety gate are sent.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { BrowserSession } from "../ats/browser";
import { QUALITY_MODE_MIN_SCORE, runAutopilot } from "../orchestrator/autopilot";
import { defaultGeneratedDir } from "../orchestrator/prepare-docs";
import type { OperatingMode } from "../ats/adapter";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const ICON = { submitted: "✅", would_submit: "📝", queued: "🕓", account: "🔑", blocked: "🚧", skipped: "⏭️", error: "⚠️" } as const;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: OperatingMode = flag(args, "--mode") === "auto" ? "auto" : "semi_auto";
  const live = args.includes("--live-submit") && mode === "auto";
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

  if (live) {
    stdout.write(
      "\n⚠️  LIVE auto-submit is ON. ApplyPilot will SUBMIT applications (to pre-approved\n" +
        "    employers, on forms that clear every safety gate). This is real and irreversible.\n"
    );
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question('    Type "SUBMIT" to proceed, anything else to dry-run: ')).trim();
    rl.close();
    if (ans !== "SUBMIT") {
      stdout.write("    -> Proceeding in DRY-RUN (nothing will be submitted).\n");
      return runPass(db, profile, { mode, liveSubmit: false, headed, args });
    }
  }

  await runPass(db, profile, { mode, liveSubmit: live, headed, args });
}

async function runPass(
  db: ReturnType<typeof getDatabase>,
  profile: NonNullable<ReturnType<ProfileRepo["getFirst"]>>,
  o: { mode: OperatingMode; liveSubmit: boolean; headed: boolean; args: string[] }
): Promise<void> {
  const cfg = loadConfig();
  const session = new BrowserSession({ headed: o.headed, minActionDelayMs: 1500, maxActionDelayMs: 4000 });
  await session.start();
  try {
    stdout.write(`\nAutopilot pass — mode=${o.mode}${o.liveSubmit ? " (LIVE submit)" : " (dry-run)"} ...\n`);
    const run = await runAutopilot(session, db, profile, {
      mode: o.mode,
      liveSubmit: o.liveSubmit,
      minScore: Number(flag(o.args, "--min-score") ?? String(QUALITY_MODE_MIN_SCORE)),
      maxTotal: Number(flag(o.args, "--max") ?? "10"),
      generatedDir: defaultGeneratedDir(cfg.dbPath),
      encryptionKey: cfg.encryptionKey,
      ...(flag(o.args, "--password-store") ? { passwordStore: flag(o.args, "--password-store")! } : {}),
      onProgress: (m) => stdout.write(`  ${m}\n`),
    });
    stdout.write("\nResults:\n");
    for (const r of run.results) {
      stdout.write(`  ${ICON[r.action]} [${r.action}] ${r.title} @ ${r.company}\n      ${r.reason}\n`);
    }
    stdout.write(
      `\nSummary: submitted ${run.submitted}, would-submit ${run.wouldSubmit}, queued ${run.queued}, blocked ${run.blocked ?? 0}, skipped ${run.skipped}.\n` +
        "Review queued items in the dashboard or with `npm run apply -- --url <jobUrl>`.\n"
    );
  } finally {
    await session.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error("autopilot failed:", err);
  process.exitCode = 1;
});
