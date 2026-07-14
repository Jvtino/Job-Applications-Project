// Data-encryption-key store (electron/key-store.cjs, commercial M7). The seal/inject I/O needs Electron
// safeStorage (validated on macOS), but the SAFETY-CRITICAL branch table — "never mint a fresh key over
// existing data" — is a pure function, exhaustively pinned here. A wrong verdict permanently orphans
// encrypted PII (crypto.ts throws on a GCM auth-tag mismatch), so this is the load-bearing test.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const { resolveDbKeyAction, envFileHasKey } = require_("../electron/key-store.cjs");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "applypilot-keystore-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("resolveDbKeyAction — the never-orphan-data safety table", () => {
  it("a sealed key that the keychain can open is decrypted (returning user)", () => {
    expect(resolveDbKeyAction({ encExists: true, envKeySet: false, dbExists: true, canEncrypt: true })).toEqual({
      action: "decrypt",
    });
  });

  it("a sealed key the keychain CANNOT open does NOT mint a second key — it does nothing", () => {
    // Keychain loss: minting a fresh key here would write ciphertext under a key that can't read the
    // existing enc=1 rows. Better to inject nothing and let the engine surface the read error.
    expect(resolveDbKeyAction({ encExists: true, envKeySet: false, dbExists: true, canEncrypt: false })).toEqual({
      action: "none",
    });
  });

  it("an existing .env key is left exactly as-is (never migrated/overwritten here)", () => {
    for (const dbExists of [true, false]) {
      for (const canEncrypt of [true, false]) {
        expect(resolveDbKeyAction({ encExists: false, envKeySet: true, dbExists, canEncrypt })).toEqual({
          action: "keep-env",
        });
      }
    }
  });

  it("GENERATES only on a provably-fresh datastore (no sealed key, no .env key, no DB) with a keychain", () => {
    expect(resolveDbKeyAction({ encExists: false, envKeySet: false, dbExists: false, canEncrypt: true })).toEqual({
      action: "generate",
    });
  });

  it("NEVER generates over an existing database, even with a keychain and no key anywhere", () => {
    // Legacy plaintext DB (enc=0 rows). Generating a key would flip new writes to enc=1 while the engine
    // still reads the old plaintext fine (per-row enc flag) — but we conservatively leave it untouched
    // so encryption is an explicit, migration-gated choice, never a silent side effect of a new key.
    expect(resolveDbKeyAction({ encExists: false, envKeySet: false, dbExists: true, canEncrypt: true })).toEqual({
      action: "none",
    });
  });

  it("does NOT generate a plaintext-at-rest key when the keychain is unavailable (headless)", () => {
    // Writing a key to a plaintext file next to the DB would defeat the whole 'unreadable without the
    // keychain' acceptance, so a fresh install with no keychain runs unencrypted instead.
    expect(resolveDbKeyAction({ encExists: false, envKeySet: false, dbExists: false, canEncrypt: false })).toEqual({
      action: "none",
    });
  });

  it("exhaustive: 'generate' appears for EXACTLY one of the 16 input combinations", () => {
    let generates = 0;
    for (const encExists of [false, true]) {
      for (const envKeySet of [false, true]) {
        for (const dbExists of [false, true]) {
          for (const canEncrypt of [false, true]) {
            const { action } = resolveDbKeyAction({ encExists, envKeySet, dbExists, canEncrypt });
            if (action === "generate") {
              generates++;
              // The one safe minting case, restated as an invariant.
              expect({ encExists, envKeySet, dbExists, canEncrypt }).toEqual({
                encExists: false,
                envKeySet: false,
                dbExists: false,
                canEncrypt: true,
              });
            }
          }
        }
      }
    }
    expect(generates).toBe(1);
  });
});

describe("envFileHasKey", () => {
  it("detects a non-empty APPLYPILOT_ENCRYPTION_KEY line", () => {
    const dir = tmp();
    const p = join(dir, ".env");
    writeFileSync(p, "APPLYPILOT_LLM_PROVIDER=embedded\nAPPLYPILOT_ENCRYPTION_KEY=deadbeef\n");
    expect(envFileHasKey(p)).toBe(true);
  });

  it("treats an empty value or a missing key as absent", () => {
    const dir = tmp();
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "APPLYPILOT_ENCRYPTION_KEY=\nANTHROPIC_API_KEY=sk-x\n");
    expect(envFileHasKey(empty)).toBe(false);
    const none = join(dir, "none.env");
    writeFileSync(none, "APPLYPILOT_LLM_PROVIDER=embedded\n");
    expect(envFileHasKey(none)).toBe(false);
    expect(envFileHasKey(join(dir, "does-not-exist.env"))).toBe(false);
  });
});
