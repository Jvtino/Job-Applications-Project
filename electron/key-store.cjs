// electron/key-store.cjs
//
// Keychain-at-rest for the at-rest DATA ENCRYPTION KEY (DEK) — commercial M7. Mirrors token-store.cjs
// but for APPLYPILOT_ENCRYPTION_KEY: the AES-256-GCM key that encrypts profile/ledger PII in the
// SQLite store (src/db/crypto.ts). The key is sealed into <userData>/db-key.enc via Electron
// `safeStorage` (macOS Keychain / Windows DPAPI / libsecret) and injected into the engine at spawn —
// it NEVER lands in .env, so a stolen data directory is unreadable without the user's OS keychain.
//
// DATA-LOSS SAFETY IS THE WHOLE GAME HERE. A wrong or absent key makes every enc=1 row permanently
// undecryptable — crypto.ts verifies a GCM auth tag and THROWS on mismatch (it never silently
// misreads). So the ONLY case that ever MINTS a new key is a provably-fresh datastore: no sealed key,
// no .env key, and no database file yet. Every other case reads existing key material or does nothing.
// It is therefore structurally impossible to generate a fresh key over an existing (differently-keyed
// or legacy-plaintext) database and orphan the data. Migrating an EXISTING .env key into the keychain
// (and scrubbing .env) is deliberately deferred to the Mac-validation-gated follow-up (M7b) alongside
// whole-file SQLCipher encryption; this module never rewrites or deletes an existing key.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Pure decision: given what already exists on disk, what should the shell DO about the DEK? Split from
 * all I/O so the safety-critical branch table is unit-testable without Electron/safeStorage.
 *   - "decrypt":  a sealed db-key.enc exists AND the keychain can open it → decrypt + inject (returning
 *                 user whose data was written under this sealed key).
 *   - "keep-env": the user already has APPLYPILOT_ENCRYPTION_KEY (env or .env) → leave it exactly as-is;
 *                 the engine reads it itself. We never touch an existing key.
 *   - "generate": provably-fresh install (no sealed key, no .env key, no DB file) AND the keychain is
 *                 available → mint + seal a new key (encryption default-ON for new users).
 *   - "none":     fresh but no keychain (headless/no keyring) → run unencrypted rather than write a
 *                 plaintext key next to the data (which would defeat the acceptance); OR a sealed blob
 *                 exists but the keychain cannot open it (keychain loss) → inject nothing and let the
 *                 engine surface the read error rather than mint a second, wrong key.
 * @param {{encExists:boolean, envKeySet:boolean, dbExists:boolean, canEncrypt:boolean}} state
 * @returns {{action:"decrypt"|"keep-env"|"generate"|"none"}}
 */
function resolveDbKeyAction(state) {
  const { encExists, envKeySet, dbExists, canEncrypt } = state;
  if (encExists) return canEncrypt ? { action: "decrypt" } : { action: "none" };
  if (envKeySet) return { action: "keep-env" };
  if (!dbExists && canEncrypt) return { action: "generate" };
  return { action: "none" };
}

/** True if the .env file at `envPath` defines a non-empty APPLYPILOT_ENCRYPTION_KEY. Best-effort. */
function envFileHasKey(envPath) {
  try {
    if (!envPath || !fs.existsSync(envPath)) return false;
    const text = fs.readFileSync(envPath, "utf8");
    // Horizontal whitespace only ([ \t], never \s) around the '=' so an EMPTY value
    // (APPLYPILOT_ENCRYPTION_KEY= followed by a newline) does not match the NEXT line's first char.
    return /^[ \t]*APPLYPILOT_ENCRYPTION_KEY[ \t]*=[ \t]*\S/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Reconcile + read the data-encryption key for `userDataDir`. Returns a 64-hex key to inject as
 * APPLYPILOT_ENCRYPTION_KEY, or null to leave encryption to the engine's own .env handling (or off).
 * Never throws. MUST be called AFTER migrateLegacyData, so a copied-in legacy DB/.env is reflected in
 * `ctx.dbPath` existence and `ctx.envPath` contents.
 * @param {import('electron').SafeStorage} safeStorage
 * @param {string} userDataDir
 * @param {{dbPath:string, envPath:string}} ctx
 */
function sealAndReadDbKey(safeStorage, userDataDir, ctx, log = console) {
  const encPath = path.join(userDataDir, "db-key.enc");
  const canEncrypt = (() => {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  })();
  const envKeySet = Boolean(process.env.APPLYPILOT_ENCRYPTION_KEY && process.env.APPLYPILOT_ENCRYPTION_KEY.trim())
    || envFileHasKey(ctx && ctx.envPath);
  const state = {
    encExists: fs.existsSync(encPath),
    envKeySet,
    dbExists: Boolean(ctx && ctx.dbPath) && fs.existsSync(ctx.dbPath),
    canEncrypt,
  };
  const { action } = resolveDbKeyAction(state);

  try {
    if (action === "decrypt") {
      return safeStorage.decryptString(fs.readFileSync(encPath));
    }
    if (action === "generate") {
      const key = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(encPath, safeStorage.encryptString(key), { mode: 0o600 });
      try {
        fs.chmodSync(encPath, 0o600);
      } catch {
        /* non-POSIX filesystem (Windows) — DPAPI blob is already user-scoped */
      }
      log.log?.(
        "[applypilot] created a data-encryption key and stored it in your OS keychain. " +
          "If you reinstall the OS or reset the keychain, encrypted data cannot be recovered — " +
          "export a recovery key from Settings to keep a backup."
      );
      return key;
    }
    // "keep-env": engine reads the existing key from .env itself — inject nothing.
    if (action === "keep-env") return null;
  } catch (e) {
    log.error?.("[applypilot] db-key seal/read failed — continuing without an injected key:", e);
    return null;
  }

  // action === "none"
  if (state.encExists && !canEncrypt) {
    log.warn?.(
      "[applypilot] a sealed data-encryption key exists but the OS keychain is unavailable — " +
        "encrypted data cannot be opened this run."
    );
  } else if (!state.dbExists && !canEncrypt) {
    log.warn?.(
      "[applypilot] OS keychain unavailable — running WITHOUT at-rest encryption (no key written to disk)."
    );
  }
  return null;
}

module.exports = { sealAndReadDbKey, resolveDbKeyAction, envFileHasKey };
