// A2: generated documents that fail ledger verification must never be attached to a live
// application. Two independent guards: prepareApplicationDocs blocks at generation time, and
// runApplication refuses to proceed even if a caller forgets to check.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { runApplication } from "../src/orchestrator/apply";
import { createBlankProfile } from "../src/profile/factory";
import type { LedgerCheckResult } from "../src/generation/ledger-check";

describe("A2: ledger check gates document attachment", () => {
  let dir: string;
  let db: DB;
  let resumePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-docsgate-"));
    db = openDatabase(join(dir, "d.sqlite"));
    resumePath = join(dir, "resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n% r\n");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const failedCheck: LedgerCheckResult = {
    passed: false,
    checks: [{ claim: { text: "Led a team of 40 engineers." }, supported: false, reason: "unsupported number" }],
  };
  const passedCheck: LedgerCheckResult = { passed: true, checks: [] };

  it("runApplication refuses to open the page or attach when the ledger check failed", async () => {
    const profile = createBlankProfile("p");
    let opened = false;
    const session = {
      open: async () => {
        opened = true;
        throw new Error("must not open a page for ledger-blocked docs");
      },
    };

    const outcome = await runApplication(session as never, db, {
      url: "https://boards.greenhouse.io/acme/jobs/1",
      profile,
      company: "Acme",
      title: "Analyst",
      resumePath,
      ledgerCheck: failedCheck,
    });

    expect(opened).toBe(false);
    expect(outcome.blocked).toBe(true);
    expect(outcome.submitted).toBe(false);
    expect(outcome.blockedReason).toMatch(/ledger verification/i);
    expect(outcome.gate.readyForOneClickSubmit).toBe(false);
  });

  it("a PASSED ledger check does not trigger the defensive block", async () => {
    const profile = createBlankProfile("p2");
    // A session whose open throws a DISTINCT error proves we got PAST the ledger guard (the guard
    // would have returned before ever calling open()).
    const session = {
      open: async () => {
        throw new Error("SENTINEL_OPENED");
      },
    };
    await expect(
      runApplication(session as never, db, {
        url: "https://boards.greenhouse.io/acme/jobs/2",
        profile,
        company: "Acme",
        title: "Analyst",
        resumePath,
        ledgerCheck: passedCheck,
      })
    ).rejects.toThrow(/SENTINEL_OPENED/);
  });
});
