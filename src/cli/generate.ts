// src/cli/generate.ts
//
// `npm run generate -- --posting <file> --company "Acme" --title "Operations Analyst" [--llm]`
// Generates a tailored resume + cover letter from the APPROVED ledger, gates them through the
// ledger verifier, renders PDF + DOCX into ./generated, and reports submission-eligibility.
// Exits non-zero if any document is NOT submission-eligible (a fabrication was blocked).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config";
import { closeDatabase, getDatabase, recordAudit } from "../db/database";
import { ProfileRepo } from "../db/profile-repo";
import { LedgerRepo } from "../db/ledger-repo";
import { resolveActiveProfile } from "../profile/active-profile";
import { parsePosting } from "../generation/posting";
import { generateApplicationDocuments, type GeneratedDoc } from "../generation/pipeline";
import { saveGeneratedDocs } from "../generation/render";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const postingPath = flag(args, "--posting");
  const company = flag(args, "--company");
  const title = flag(args, "--title");
  const location = flag(args, "--location");
  const outDir = flag(args, "--out") ?? "./generated";

  if (!postingPath) {
    process.stderr.write(
      'Usage: npm run generate -- --posting <file> --company "Co" --title "Role" [--location "City, ST"] [--llm] [--out ./generated]\n'
    );
    process.exitCode = 1;
    return;
  }

  const cfg = loadConfig();
  const db = getDatabase(cfg.dbPath);
  const profile = resolveActiveProfile(new ProfileRepo(db, cfg.encryptionKey), { demoMode: cfg.demoMode });
  if (!profile) {
    process.stderr.write("No profile found. Run `npm run setup` and `npm run ingest` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }
  const ledger = new LedgerRepo(db, cfg.encryptionKey).get(profile.id);
  if (!ledger) {
    process.stderr.write("No facts ledger found. Run `npm run ingest` first.\n");
    process.exitCode = 1;
    closeDatabase();
    return;
  }

  const rawPosting = await readFile(resolve(postingPath), "utf8");
  const posting = parsePosting(rawPosting, {
    ...(title ? { title } : {}),
    ...(company ? { company } : {}),
    ...(location ? { location } : {}),
  });

  process.stdout.write(
    `Generating for "${posting.title}" at "${posting.company}" using ${useLlm ? "LLM-if-available" : "template"} generator...\n`
  );
  const result = await generateApplicationDocuments(ledger, profile, posting, { useLlm });

  reportDoc("Resume", result.resume);
  reportDoc("Cover letter", result.coverLetter);

  const slug = slugify(`${posting.company}-${posting.title}`);
  const saved = await saveGeneratedDocs(result.resume.model, result.coverLetter.model, outDir, slug);
  process.stdout.write(`\nSaved (for inspection):\n  ${Object.values(saved).join("\n  ")}\n`);

  recordAudit(db, profile.id, "documents.generate", {
    company: posting.company,
    title: posting.title,
    generator: result.generator,
    resumeEligible: result.resume.submissionEligible,
    coverLetterEligible: result.coverLetter.submissionEligible,
  });

  if (result.allEligible) {
    process.stdout.write("\nBoth documents PASS the ledger check — submission-eligible. ✅\n");
  } else {
    process.stdout.write(
      "\nOne or more documents are NOT submission-eligible (fabrication blocked). ❌\n" +
        "Fix the facts ledger or regenerate before submitting.\n"
    );
  }

  closeDatabase();
  process.exitCode = result.allEligible ? 0 : 1;
}

function reportDoc(label: string, doc: GeneratedDoc): void {
  const failed = doc.check.checks.filter((c) => !c.supported);
  process.stdout.write(
    `\n${label}: ${doc.submissionEligible ? "PASS ✅" : "FAIL ❌"} ` +
      `(${doc.check.checks.length} claims, ${failed.length} unsupported)\n`
  );
  for (const c of failed) {
    process.stdout.write(`  • "${c.claim.text}"\n      ↳ ${c.reason}\n`);
  }
}

main().catch((err) => {
  console.error("generate failed:", err);
  process.exitCode = 1;
});
