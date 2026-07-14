// src/cli/schedule.ts
//
// `npm run schedule -- --every 60m [--mode auto|semi] [--live-submit] [--daily 30] [--max 10]
//                       [--max-per-company 3] [--min-score 0.5] [--jitter 25%] [--headless]
//                       [--password-store "1Password"]`
//
// Long-running 24/7 driver: runs an autopilot pass on an interval. SAFE BY DEFAULT — mode=semi fills
// and queues for your one-click review (submits nothing). Live auto-submit needs BOTH `--mode auto`
// AND `--live-submit`, only sends to pre-approved employers on forms that clear every safety gate,
// and asks you to type SUBMIT once at startup. A daily ceiling + per-company caps + jittered pacing
// bound the volume; hard dedup means a submitted job is never sent twice (even across restarts).
//
// For true always-on, run this under a supervisor (launchd on macOS, or pm2) so it restarts on
// reboot/crash; the persistent browser profile keeps your logins across restarts.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { runAutopilotPass } from "../server/autopilot-runner";
import { defaultGeneratedDir } from "../orchestrator/prepare-docs";
import { runScheduler, type ScheduleConfig } from "../orchestrator/scheduler";
import type { OperatingMode } from "../ats/adapter";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Parse "30s" / "45m" / "2h"; a bare number means minutes. */
function parseDuration(s: string | undefined, defMs: number): number {
  if (!s) return defMs;
  const m = /^(\d+)\s*(s|m|h)$/i.exec(s.trim());
  if (m) {
    const n = Number(m[1]);
    const u = m[2]!.toLowerCase();
    return u === "s" ? n * 1000 : u === "h" ? n * 3_600_000 : n * 60_000;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n * 60_000 : defMs;
}

const MIN_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: OperatingMode = flag(args, "--mode") === "auto" ? "auto" : "semi_auto";
  const headed = !args.includes("--headless");

  let everyMs = parseDuration(flag(args, "--every"), 60 * 60_000);
  if (everyMs < MIN_INTERVAL_MS) {
    stdout.write(`Interval clamped to the ${MIN_INTERVAL_MS / 1000}s minimum (pacing).\n`);
    everyMs = MIN_INTERVAL_MS;
  }

  const jitterArg = flag(args, "--jitter");
  const jitterMs = jitterArg?.endsWith("%")
    ? Math.floor((Number(jitterArg.slice(0, -1)) / 100) * everyMs)
    : parseDuration(jitterArg, Math.floor(everyMs * 0.25));

  const cfg: ScheduleConfig = {
    everyMs,
    mode,
    liveSubmit: args.includes("--live-submit") && mode === "auto",
    minScore: Number(flag(args, "--min-score") ?? "0.5"),
    maxPerPass: Number(flag(args, "--max") ?? "10"),
    maxPerCompany: Number(flag(args, "--max-per-company") ?? "3"),
    dailyCeiling: Number(flag(args, "--daily") ?? "30"),
    jitterMs,
  };

  const config = loadConfig();
  const db = getDatabase(config.dbPath);
  const profile = resolveActiveProfile(new ProfileRepo(db, config.encryptionKey), { demoMode: config.demoMode });
  if (!profile) {
    process.stderr.write("No profile found. Run `npm run setup` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }

  if (cfg.liveSubmit) {
    stdout.write(
      "\n⚠️  LIVE auto-submit scheduler. This will SUBMIT applications unattended, on an interval,\n" +
        "    to pre-approved employers whose forms clear every safety gate. Real and irreversible.\n" +
        `    Guardrails: <= ${cfg.dailyCeiling}/day, <= ${cfg.maxPerCompany}/company/pass, every ~${Math.round(everyMs / 60000)}m.\n`
    );
    const rl = createInterface({ input: stdin, output: stdout });
    const ans = (await rl.question('    Type "SUBMIT" to run LIVE, anything else for dry-run: ')).trim();
    rl.close();
    if (ans !== "SUBMIT") {
      cfg.liveSubmit = false;
      stdout.write("    -> Running in DRY-RUN (auto mode shows what WOULD submit; nothing is sent).\n");
    }
  }

  const passwordStore = flag(args, "--password-store");

  // Interruptible sleep so Ctrl-C stops within the current sleep, not after the full interval.
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    stdout.write("\nStopping after the current pass…\n");
    wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  stdout.write(
    `\nApplyPilot scheduler — mode=${cfg.mode}${cfg.liveSubmit ? " (LIVE submit)" : " (dry-run/queue)"}, ` +
      `every ~${Math.round(everyMs / 60000)}m (+ up to ${Math.round(jitterMs / 1000)}s jitter), ` +
      `daily ceiling ${cfg.dailyCeiling}, <= ${cfg.maxPerCompany}/company/pass.\n` +
      "Press Ctrl-C to stop. For true 24/7, run under launchd (macOS) or pm2.\n\n"
  );

  try {
    const finalState = await runScheduler(cfg, {
      runPass: (maxTotal) =>
        runAutopilotPass(db, profile, {
          mode: cfg.mode,
          liveSubmit: cfg.liveSubmit,
          headed,
          minScore: cfg.minScore,
          maxPerCompany: cfg.maxPerCompany,
          maxTotal,
          generatedDir: defaultGeneratedDir(config.dbPath),
          encryptionKey: config.encryptionKey,
          ...(passwordStore ? { passwordStore } : {}),
          onProgress: (m) => stdout.write(`  ${m}\n`),
        }),
      log: (m) => stdout.write(`${m}\n`),
      shouldStop: () => stopping,
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            wake = null;
            resolve();
          }, ms);
          wake = () => {
            clearTimeout(t);
            wake = null;
            resolve();
          };
        }),
    });
    stdout.write(
      `\nScheduler stopped. This window: ${finalState.processedInWindow} processed, ` +
        `${finalState.submittedInWindow} submitted across ${finalState.passes} passes.\n`
    );
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  console.error("scheduler failed:", err);
  process.exitCode = 1;
});
