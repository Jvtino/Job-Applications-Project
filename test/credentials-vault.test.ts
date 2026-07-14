// Secure credential vault (src/db/credentials-vault.ts). Verifies the SECURITY guarantees (password
// round-trips only via getPassword(), encrypted at rest, never in metadata) AND the owner's STORAGE
// requirements: stored in a stable home-dir folder, SURVIVES delete/reinstall (a fresh vault on the
// same dir still decrypts, via the persisted key file), and reports WHERE it lives. Uses a temp dir,
// so it touches no real home directory or keychain.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialsVault, credentialDomainKey } from "../src/db/credentials-vault";

let dir: string;
const vault = () => new CredentialsVault({ dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "applypilot-vault-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CredentialsVault — security", () => {
  it("round-trips a saved password only through getPassword()", () => {
    const v = vault();
    v.set({ domain: "td.wd3.myworkdayjobs.com", email: "me@example.com", password: "S3cret-Pass!" });
    expect(v.getPassword("td.wd3.myworkdayjobs.com")).toEqual({ email: "me@example.com", password: "S3cret-Pass!" });
  });

  it("stores the password ENCRYPTED at rest — the plaintext never appears in the file", () => {
    vault().set({ domain: "acme.wd1.myworkdayjobs.com", email: "me@example.com", password: "PlaintextShouldNotAppear" });
    const raw = readFileSync(join(dir, "credentials.json"), "utf8");
    expect(raw).not.toContain("PlaintextShouldNotAppear");
    expect(raw).toContain("passwordEnc");
  });

  it("never exposes the password in list()/getMeta() metadata", () => {
    const v = vault();
    v.set({ domain: "acme.wd1.myworkdayjobs.com", email: "me@example.com", password: "hunter2hunter2", origin: "generated" });
    expect(v.getMeta("acme.wd1.myworkdayjobs.com")).toEqual(
      expect.objectContaining({ email: "me@example.com", hasPassword: true, origin: "generated" })
    );
    expect(JSON.stringify(v.list())).not.toContain("hunter2");
  });
});

describe("CredentialsVault — storage that survives delete/reinstall", () => {
  it("a FRESH vault on the same folder still decrypts (persisted key file = survives reinstall)", () => {
    new CredentialsVault({ dir }).set({ domain: "td.wd3.myworkdayjobs.com", email: "me@example.com", password: "keep-across-reinstall" });
    // Simulate deleting + reinstalling the app: a brand-new vault instance, same home folder.
    const reinstalled = new CredentialsVault({ dir });
    expect(reinstalled.getPassword("td.wd3.myworkdayjobs.com")?.password).toBe("keep-across-reinstall");
    expect(existsSync(join(dir, "credentials.key"))).toBe(true); // the key persists next to the data
  });

  it("reports where the logins are saved (path in the home folder, not the app)", () => {
    const loc = vault().location();
    expect(loc.path).toBe(join(dir, "credentials.json"));
    expect(loc.keyPath).toBe(join(dir, "credentials.key"));
    expect(loc.note).toMatch(/delete ApplyPilot|home directory/i);
  });
});

describe("CredentialsVault — CRUD", () => {
  it("normalizes domain/URL to a stable host key so a URL and a bare host collide", () => {
    expect(credentialDomainKey("https://td.wd3.myworkdayjobs.com/en-US/x")).toBe("td.wd3.myworkdayjobs.com");
    const v = vault();
    v.set({ domain: "https://td.wd3.myworkdayjobs.com/en-US/careers", email: "me@example.com", password: "p1" });
    expect(v.getPassword("td.wd3.myworkdayjobs.com")?.password).toBe("p1");
  });

  it("leaves the password untouched when omitted, and clears it on empty string", () => {
    const v = vault();
    v.set({ domain: "d.myworkdayjobs.com", email: "me@example.com", password: "keep-me" });
    v.set({ domain: "d.myworkdayjobs.com", email: "new@example.com" }); // update email only
    expect(v.getMeta("d.myworkdayjobs.com")?.email).toBe("new@example.com");
    expect(v.getPassword("d.myworkdayjobs.com")?.password).toBe("keep-me");
    v.set({ domain: "d.myworkdayjobs.com", email: "new@example.com", password: "" }); // clear
    expect(v.getMeta("d.myworkdayjobs.com")?.hasPassword).toBe(false);
    expect(v.getPassword("d.myworkdayjobs.com")).toBeNull();
  });

  it("deletes an entry and returns null for a missing one", () => {
    const v = vault();
    v.set({ domain: "d.myworkdayjobs.com", email: "me@example.com", password: "p" });
    v.delete("d.myworkdayjobs.com");
    expect(v.getMeta("d.myworkdayjobs.com")).toBeNull();
    expect(v.getPassword("nope.myworkdayjobs.com")).toBeNull();
  });
});
