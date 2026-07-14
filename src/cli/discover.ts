// src/cli/discover.ts
//
// `npm run discover [-- --targets config/targets.json] [--min-score 0.3]`
//
// ONE command, BOTH sources. Seeds your target employers from a hand-maintained config file, then
// runs a single finder discovery pass across those employer ATS boards AND any exported
// LinkedIn/Indeed job-alert emails (APPLYPILOT_ALERT_MAIL_DIR). Results are deduped across sources,
// US-filtered, and scored against your résumé, then printed ranked. Read-only: discovery records
// apply URLs but NEVER applies or submits.

import { readFileSync } from "node:fs";
import { stdout, stderr } from "node:process";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { CompaniesRepo } from "../db/companies-repo";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { runDiscoveryPass } from "../server/discovery-runner";
import { slugFromBoardUrl } from "../jobs/board-detect";
import type { AtsType } from "../jobs/types";
import type { Fact } from "../types/facts-ledger";

/** Vendors with a first-class finder connector (the single-user refocus source set). */
const SUPPORTED_VENDORS = new Set<string>([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "workday",
]);

/**
 * Idempotency key for a target. Workday boards are identified by their full careers URL (host +
 * tenant + site), so key on the normalized URL; every other vendor is a bare slug.
 */
function targetKey(vendor: string, boardUrlOrId: string): string {
  if (vendor === "workday") return `workday:${boardUrlOrId.toLowerCase().replace(/\/+$/, "")}`;
  return `${vendor}:${slugFromBoardUrl(vendor as AtsType, boardUrlOrId) ?? boardUrlOrId}`;
}

interface TargetEntry {
  name?: string;
  vendor?: string;
  boardId?: string;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Seed target employers from the hand-maintained config file into the companies list. Idempotent —
 * a board already present is skipped. Placeholder/unfilled entries are skipped with a clear note
 * (a board identifier must be observed from the employer's own careers page, never guessed).
 */
function seedTargets(repo: CompaniesRepo, path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0; // no targets file — fall back to whatever companies already exist
  }
  let parsed: { targets?: TargetEntry[] };
  try {
    parsed = JSON.parse(raw) as { targets?: TargetEntry[] };
  } catch {
    stderr.write(`Could not parse ${path} as JSON — skipping target seeding.\n`);
    return 0;
  }

  const existing = new Set(repo.list().map((c) => targetKey(c.atsType, c.boardUrl)));
  let added = 0;
  for (const t of parsed.targets ?? []) {
    const vendor = (t.vendor ?? "").toLowerCase().trim();
    const boardId = (t.boardId ?? "").trim();
    if (!SUPPORTED_VENDORS.has(vendor)) {
      stderr.write(
        `Skipping "${t.name ?? boardId}": unsupported vendor "${t.vendor}" ` +
          `(use greenhouse | lever | ashby | smartrecruiters | workable | workday).\n`,
      );
      continue;
    }
    if (!boardId || /replace|example|your-/i.test(boardId)) {
      stderr.write(
        `Skipping "${t.name ?? vendor}": fill in a real boardId observed from the employer's ` +
          `careers page — never a guessed identifier.\n`,
      );
      continue;
    }
    if (vendor === "workday" && !/(myworkdayjobs|myworkdaysite)\.com/i.test(boardId)) {
      stderr.write(
        `Skipping "${t.name ?? vendor}": Workday needs the full careers board URL ` +
          `(https://<tenant>.wdN.myworkdayjobs.com/<site>), not a bare slug.\n`,
      );
      continue;
    }
    const key = targetKey(vendor, boardId);
    if (existing.has(key)) continue;
    repo.add(t.name?.trim() || boardId, boardId, vendor as AtsType);
    existing.add(key);
    added++;
  }
  return added;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetsPath = flag(args, "--targets") ?? "config/targets.json";
  const minScore = Number(flag(args, "--min-score") ?? "0");

  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  try {
    const profile = resolveActiveProfile(new ProfileRepo(db, cfg.encryptionKey), {
      demoMode: cfg.demoMode,
    });
    if (!profile) {
      stderr.write("No profile found. Run `npm run setup` first.\n");
      process.exitCode = 1;
      return;
    }

    const companies = new CompaniesRepo(db);
    const added = seedTargets(companies, targetsPath);
    if (added > 0) stdout.write(`Seeded ${added} target employer(s) from ${targetsPath}.\n`);

    const ledger = new LedgerRepo(db, cfg.encryptionKey).get(profile.id);
    const approvedFacts: Fact[] = (ledger?.facts ?? []).filter((f) => f.approved);

    const boardCount = companies.list({ enabledOnly: true }).length;
    const mailDir = process.env.APPLYPILOT_ALERT_MAIL_DIR?.trim();
    stdout.write(
      `Discovering across ${boardCount} employer board(s)` +
        (mailDir ? ` + job-alert emails in ${mailDir}` : "") +
        "…\n",
    );

    const run = await runDiscoveryPass(db, profile, approvedFacts, {
      onProgress: (m) => stdout.write(`  ${m}\n`),
    });

    const ranked = run.scored.filter((p) => p.score >= minScore).sort((a, b) => b.score - a.score);

    stdout.write(`\nFound ${run.scored.length} job(s); ${run.newlyAdded.length} new this run.\n\n`);
    for (const p of ranked) {
      const pct = String(Math.round(p.score * 100)).padStart(3);
      stdout.write(
        `  [${pct}%] ${p.title} — ${p.company} (${p.atsType})\n` +
          `        ${p.location ?? ""}  ${p.jobUrl}\n`,
      );
    }
    if (!ranked.length) stdout.write("  (no jobs at or above the score threshold)\n");
  } finally {
    closeDatabase();
  }
}

main().catch((err) => {
  stderr.write(`discover failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
  closeDatabase();
});
