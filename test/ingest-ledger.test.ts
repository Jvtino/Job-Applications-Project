// In-app résumé ingest (M3): upload -> parse -> facts ledger, then approve/remove via the API.
//
// The safety-critical property: parsed facts land UNAPPROVED, and only an explicit user action
// approves them — because only approved facts may ever reach a generated document. The ledger stays
// separate from the profile store.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openDatabase, type DB } from "../src/db/database";
import { ProfileRepo } from "../src/db/profile-repo";
import { LedgerRepo } from "../src/db/ledger-repo";
import { createBlankProfile } from "../src/profile/factory";
import { ingestResumeBuffer } from "../src/server/ingest-runner";
import { startApiServer } from "../src/server/api";

const here = dirname(fileURLToPath(import.meta.url));
const RESUME = readFileSync(join(here, "fixtures", "sample-resume.txt"));

async function listening(server: http.Server): Promise<string> {
  await new Promise<void>((r) => (server.listening ? r() : server.once("listening", () => r())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("ingestResumeBuffer", () => {
  it("parses a résumé into UNAPPROVED facts and sets masterResumePath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-ing-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    const out = await ingestResumeBuffer(db, undefined, createBlankProfile("ing"), join(dir, "resumes"), {
      filename: "resume.txt",
      buffer: RESUME,
    });
    expect(out.ledger.facts.length).toBeGreaterThan(0);
    expect(out.ledger.facts.every((f) => f.approved === false)).toBe(true); // nothing auto-approved
    expect(new ProfileRepo(db, undefined).getFirst()?.masterResumePath).toBeTruthy();
    const saved = new ProfileRepo(db, undefined).getFirst()!;
    expect(saved.contact.legalFirstName).toBe("Jane");
    expect(saved.contact.email).toBe("jane.applicant@example.com");
    expect(out.profileFieldsFilled).toBeGreaterThan(3);
    expect(new LedgerRepo(db, undefined).get("ing")?.facts.filter((f) => f.approved).length).toBe(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unsupported file type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "applypilot-ing2-"));
    const db = openDatabase(join(dir, "p.sqlite"));
    await expect(
      ingestResumeBuffer(db, undefined, createBlankProfile("x"), join(dir, "resumes"), { filename: "resume.exe", buffer: Buffer.from("x") })
    ).rejects.toThrow(/Unsupported/);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("/api/resume/ingest + /api/ledger", () => {
  let dir: string;
  let db: DB;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "applypilot-ledapi-"));
    db = openDatabase(join(dir, "p.sqlite"));
    server = startApiServer(0, { db, envPath: join(dir, ".env"), resumesDir: join(dir, "resumes") });
    base = await listening(server);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ingests, then approves / unapproves / removes facts", async () => {
    const empty = await (await fetch(`${base}/api/ledger`)).json();
    expect(empty.facts).toHaveLength(0);

    const ing = await fetch(`${base}/api/resume/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "resume.txt", contentBase64: RESUME.toString("base64") }),
    });
    expect(ing.status).toBe(200);
    const ingBody = await ing.json();
    expect(ingBody.facts.length).toBeGreaterThan(1);
    expect(ingBody.summary.approved).toBe(0); // unapproved on ingest
    expect(ingBody.form?.legalFirstName).toBe("Jane");
    expect(ingBody.form?.email).toBe("jane.applicant@example.com");
    expect(ingBody.profileFieldsFilled).toBeGreaterThan(3);

    const allBody = await (await fetch(`${base}/api/ledger`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approveAll: true }),
    })).json();
    expect(allBody.summary.approved).toBe(allBody.summary.total);

    const firstId: string = allBody.facts[0].id;
    const secondId: string = allBody.facts[1].id;

    const unap = await (await fetch(`${base}/api/ledger`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setApproved: [{ id: firstId, approved: false }] }),
    })).json();
    expect(unap.facts.find((f: { id: string }) => f.id === firstId)!.approved).toBe(false);

    const removed = await (await fetch(`${base}/api/ledger`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ remove: [secondId] }),
    })).json();
    expect(removed.facts.find((f: { id: string }) => f.id === secondId)).toBeUndefined();
  });
});
