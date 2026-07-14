// src/cli/companies.ts
//
// `npm run companies -- <add|list|remove|enable|disable|approve|disapprove> ...`
// Manage the seeded list of target companies/sources for discovery.

import { loadConfig } from "../config";
import { closeDatabase, getDatabase } from "../db/database";
import { CompaniesRepo } from "../db/companies-repo";
import { normalizeBoard } from "../jobs/board-detect";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const repo = new CompaniesRepo(db);

  try {
    if (cmd === "add") {
      const url = args.find((a, i) => i > 0 && !a.startsWith("--"));
      if (!url) return usage();
      const nameOverride = flag(args, "--name");

      // A board URL is added directly; a company homepage/careers URL is resolved by browsing.
      const direct = normalizeBoard(url);
      if (direct) {
        const c = repo.add(nameOverride ?? direct.name, direct.boardUrl, direct.atsType);
        process.stdout.write(`Added ${c.name} [${c.atsType}] ${c.boardUrl}\n  id: ${c.id}\n`);
      } else {
        process.stderr.write(
          "Couldn't recognize a supported job board in that URL. Paste the board URL directly, e.g.\n" +
            "  npm run companies -- add https://job-boards.greenhouse.io/<slug>\n" +
            "  npm run companies -- add https://jobs.lever.co/<site>\n"
        );
        process.exitCode = 1;
      }
    } else if (cmd === "list" || cmd === undefined) {
      const all = repo.list();
      if (!all.length) {
        process.stdout.write("No companies yet. Add one: npm run companies -- add <board-url>\n");
      }
      for (const c of all) {
        process.stdout.write(
          `${c.enabled ? "•" : "○"} ${c.name} [${c.atsType}]${c.autoSubmitApproved ? " (auto-submit approved)" : ""}\n` +
            `    ${c.boardUrl}\n    id: ${c.id}\n`
        );
      }
    } else if (cmd === "remove") {
      const id = args[1];
      if (!id) return usage();
      repo.remove(id);
      process.stdout.write("Removed.\n");
    } else if (cmd === "enable" || cmd === "disable") {
      const id = args[1];
      if (!id) return usage();
      repo.setEnabled(id, cmd === "enable");
      process.stdout.write(`${cmd}d.\n`);
    } else if (cmd === "approve" || cmd === "disapprove") {
      const id = args[1];
      if (!id) return usage();
      repo.setAutoSubmitApproved(id, cmd === "approve");
      process.stdout.write(
        `${cmd === "approve" ? "Approved" : "Removed approval"} for 24/7 auto-submit (CAPTCHA-free forms only).\n`
      );
    } else {
      usage();
    }
  } finally {
    closeDatabase();
  }
}

function usage(): void {
  process.stderr.write(
    "Usage:\n" +
      "  npm run companies -- add <company-homepage-or-board-url> [--name \"Acme\"] [--headed]\n" +
      "  npm run companies -- list\n" +
      "  npm run companies -- remove <id>\n" +
      "  npm run companies -- enable|disable <id>\n" +
      "  npm run companies -- approve|disapprove <id>   (24/7 auto-submit allowlist)\n"
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("companies failed:", err);
  process.exitCode = 1;
});
