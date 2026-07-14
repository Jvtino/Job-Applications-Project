// src/cli/verify-doc.ts
//
// `npm run verify-doc -- <path-to-document> [--llm] [--allow "Target Company,Other"]`
// Runs the ledger verifier against the approved facts ledger and reports per-claim results,
// highlighting any sentence that asserts something outside the ledger. Exits non-zero on fail
// (so it can gate a generation pipeline).

import { resolve } from "node:path";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { extractResumeText } from "../ingestion/extract-text";
import { createLedgerVerifier } from "../generation/ledger-verifier";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const allowIdx = args.indexOf("--allow");
  const allowlist =
    allowIdx >= 0 && args[allowIdx + 1]
      ? args[allowIdx + 1]!.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const path = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--allow");
  if (!path) {
    process.stderr.write(
      'Usage: npm run verify-doc -- <document.(txt|md|pdf|docx)> [--llm] [--allow "Co A,Co B"]\n'
    );
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const profileRepo = new ProfileRepo(db, cfg.encryptionKey);
  const ledgerRepo = new LedgerRepo(db, cfg.encryptionKey);

  const profile = resolveActiveProfile(profileRepo, { demoMode: cfg.demoMode });
  if (!profile) {
    process.stderr.write("No profile found. Run `npm run ingest -- <resume>` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }
  const ledger = ledgerRepo.get(profile.id);
  if (!ledger) {
    process.stderr.write("No ledger found for the profile. Run `npm run ingest` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }

  const { text } = await extractResumeText(resolve(path));
  const verifier = createLedgerVerifier({ useLlm, allowlist });
  const result = await verifier.verify(text, ledger);

  process.stdout.write(`\nLedger check: ${result.passed ? "PASS ✅" : "FAIL ❌"}\n`);
  const failed = result.checks.filter((c) => !c.supported);
  process.stdout.write(`${result.checks.length} claim(s), ${failed.length} unsupported.\n`);
  if (failed.length > 0) {
    process.stdout.write("\nUnsupported claims (NOT submission-eligible):\n");
    for (const c of failed) {
      process.stdout.write(`  • "${c.claim.text}"\n      ↳ ${c.reason}\n`);
    }
  }

  closeDatabase();
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((err) => {
  console.error("verify-doc failed:", err);
  process.exitCode = 1;
});
