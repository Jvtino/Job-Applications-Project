import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { createBlankProfile } from "../src/profile/factory";
import { buildLedger } from "../src/ingestion/ledger-ops";
import { applicantProfileSchema } from "../src/validation/applicant-profile.schema";

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "applypilot-"));
  db = openDatabase(join(dir, "test.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("profile + ledger datastore", () => {
  it("round-trips a profile unencrypted", () => {
    const repo = new ProfileRepo(db, undefined);
    const profile = createBlankProfile("u1");
    profile.contact.legalFirstName = "Jane";
    profile.contact.email = "jane@example.com";

    repo.save(profile);
    const loaded = repo.get("u1");
    expect(loaded?.contact.legalFirstName).toBe("Jane");
    expect(loaded?.contact.email).toBe("jane@example.com");
    expect(loaded?.workAuthorization.authorizedToWorkInUS.source).toBe("default");
  });

  it("encrypts at rest when a key is configured", () => {
    const key = randomBytes(32);
    const repo = new ProfileRepo(db, key);
    const profile = createBlankProfile("u2");
    profile.contact.legalLastName = "SecretSurname";
    repo.save(profile);

    // Raw bytes on disk must NOT contain the plaintext PII.
    const row = db.prepare("SELECT data, enc FROM profiles WHERE id = ?").get("u2") as {
      data: Buffer;
      enc: number;
    };
    expect(row.enc).toBe(1);
    expect(row.data.toString("utf8")).not.toContain("SecretSurname");

    // Reading with the key works…
    expect(repo.get("u2")?.contact.legalLastName).toBe("SecretSurname");
    // …without the key, it refuses rather than returning garbage.
    const noKeyRepo = new ProfileRepo(db, undefined);
    expect(() => noKeyRepo.get("u2")).toThrow();
  });

  it("round-trips a facts ledger", () => {
    const profileRepo = new ProfileRepo(db, undefined);
    const ledgerRepo = new LedgerRepo(db, undefined);
    profileRepo.save(createBlankProfile("u3"));

    const ledger = buildLedger("u3", [
      { id: "f1", type: "skill", approved: true, statement: "SQL" },
    ]);
    ledgerRepo.save(ledger);
    const loaded = ledgerRepo.get("u3");
    expect(loaded?.facts).toHaveLength(1);
    expect(loaded?.facts[0]?.type).toBe("skill");
  });

  it("rejects structurally-invalid profile data via Zod", () => {
    expect(() => applicantProfileSchema.parse({ id: "x" })).toThrow();
    const good = createBlankProfile("ok");
    expect(() => applicantProfileSchema.parse(good)).not.toThrow();
  });
});
