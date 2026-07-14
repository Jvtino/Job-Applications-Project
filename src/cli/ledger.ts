// src/cli/ledger.ts
//
// `npm run ledger` — view the stored facts ledger and its approval state. Read-only inspector
// (editing/approval happens during `npm run ingest`). Useful before generating documents.

import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { describeFact, summarizeLedger } from "../ingestion/ledger-ops";

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
  const ledger = new LedgerRepo(db, cfg.encryptionKey).get(profile.id);
  if (!ledger) {
    process.stderr.write("No ledger found. Run `npm run ingest -- <resume>` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }

  const summary = summarizeLedger(ledger);
  process.stdout.write(`Facts ledger for profile ${profile.id}\n`);
  process.stdout.write(`Approved ${summary.approved}/${summary.total}` + (ledger.approvedAt ? ` (last approved ${ledger.approvedAt})` : "") + "\n\n");
  for (const [type, counts] of Object.entries(summary.byType)) {
    process.stdout.write(`  ${type}: ${counts.approved}/${counts.total} approved\n`);
  }
  process.stdout.write("\nFacts:\n");
  for (const f of ledger.facts) {
    process.stdout.write(`  [${f.approved ? "x" : " "}] ${describeFact(f)}\n`);
  }
  closeDatabase();
}

main();
