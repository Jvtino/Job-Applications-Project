// Document preparation before apply — master résumé fallback and tailored generation.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { createBlankProfile } from "../src/profile/factory";
import { defaultGeneratedDir, prepareApplicationDocs } from "../src/orchestrator/prepare-docs";
import { ingestResumeBuffer } from "../src/server/ingest-runner";
import { approveAll } from "../src/ingestion/ledger-ops";
import { LedgerRepo } from "../src/db/ledger-repo";

const here = dirname(fileURLToPath(import.meta.url));
const RESUME = readFileSync(join(here, "fixtures", "sample-resume.txt"));

describe("prepareApplicationDocs", () => {
  let dir: string;
  let db: DB;
  let genDir: string;
  let resumePath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-prep-"));
    genDir = join(dir, "generated");
    resumePath = join(dir, "master.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n% master\n");
    db = openDatabase(join(dir, "prep.sqlite"));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaultGeneratedDir sits alongside the datastore", () => {
    expect(defaultGeneratedDir(join(dir, "data", "app.sqlite"))).toBe(join(dir, "data", "generated"));
  });

  it("A3: falls back to master résumé ONLY in preview mode, never for automated apply", async () => {
    const profile = createBlankProfile("master-only");
    profile.masterResumePath = resumePath;
    new ProfileRepo(db, undefined).save(profile);

    // Preview/manual-download path: the raw master résumé is allowed.
    const docs = await prepareApplicationDocs(db, undefined, genDir, profile, { company: "Acme", title: "Analyst" }, { previewOnly: true });
    expect(docs.generator).toBe("master");
    expect(docs.resumePath).toBe(resumePath);
    expect(docs.coverLetterPath).toBeUndefined();
    // The raw master résumé was never verified against the ledger, so it is NOT attach-eligible.
    expect(docs.allEligible).toBe(false);

    // Automated apply path (no previewOnly): the master bypass is refused — approve facts first.
    await expect(
      prepareApplicationDocs(db, undefined, genDir, profile, { company: "Acme", title: "Analyst" })
    ).rejects.toThrow(/approve résumé facts/i);
  });

  it("generates tailored PDFs when approved facts exist", async () => {
    const profile = createBlankProfile("tailored");
    profile.contact.legalFirstName = "Jane";
    profile.contact.legalLastName = "Applicant";
    profile.contact.email = "jane@example.com";
    new ProfileRepo(db, undefined).save(profile);

    const resumesDir = join(dir, "resumes");
    const ingested = await ingestResumeBuffer(db, undefined, profile, resumesDir, {
      filename: "resume.txt",
      buffer: RESUME,
    });
    const approved = approveAll(ingested.ledger);
    new LedgerRepo(db, undefined).save(approved);

    const docs = await prepareApplicationDocs(db, undefined, genDir, profile, {
      company: "Acme",
      title: "Operations Analyst",
      rationale: "Strong reporting fit",
    });

    expect(docs.generator).toBe("tailored");
    expect(existsSync(docs.resumePath)).toBe(true);
    expect(docs.coverLetterPath).toBeTruthy();
    expect(existsSync(docs.coverLetterPath!)).toBe(true);
    expect(docs.allEligible).toBe(true);
  });

  it("throws when neither approved facts nor master résumé exist", async () => {
    const profile = createBlankProfile("empty");
    new ProfileRepo(db, undefined).save(profile);

    await expect(
      prepareApplicationDocs(db, undefined, genDir, profile, { company: "Acme", title: "Role" })
    ).rejects.toThrow(/approved|résumé/i);
  });
});
