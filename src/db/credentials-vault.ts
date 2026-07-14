// src/db/credentials-vault.ts
//
// Secure credential vault — per-site login (email + password) that ApplyPilot may save and
// auto-enter (owner-approved amendment to brief #5; see BUILD_BRIEF.md / CLAUDE.md).
//
// STORAGE (owner requirements): credentials are stored LOCALLY, they SURVIVE deleting the app, and
// the app tells the user WHERE they live. To satisfy all three, the vault lives in a stable folder
// in the user's HOME directory (default ~/ApplyPilot/), NOT in the app's data dir — a home folder is
// not removed when the app is deleted, so the logins remain across delete/reinstall. `location()`
// returns the exact path for the UI to display.
//
// SECURITY POSTURE (do not weaken):
//   - Passwords are encrypted at rest with AES-256-GCM (db/crypto) using a 32-byte key kept in a
//     0600 key file NEXT TO the vault (credentials.key). The key is self-provisioned on first use
//     and persists alongside the data, so credentials still decrypt after the app is reinstalled.
//     The file-permission boundary (0600, user-owned home dir) is the practical protection on a
//     single-user machine; the encryption additionally guards against casual reads / backups.
//   - Plaintext passwords are NEVER written to the vault file. getPassword() is the ONLY method that
//     returns a secret (for the auto-fill path); list()/getMeta() NEVER include a password.
//     Passwords are NEVER logged and NEVER committed (the home-dir vault is outside the repo).

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decryptBytes, encryptBytes } from "./crypto";

export type CredentialOrigin = "user" | "generated";

/** Safe-to-display metadata for a saved login. NEVER carries the password. */
export interface CredentialMeta {
  domain: string;
  email: string;
  hasPassword: boolean;
  /** "user" = you entered it; "generated" = the app made it during account creation. */
  origin: CredentialOrigin;
  updatedAt: string;
}

/** Where the vault lives, for the "Logins" tab to show the user. */
export interface VaultLocation {
  dir: string;
  path: string;
  keyPath: string;
  /** Plain-language note for the UI. */
  note: string;
}

interface StoredEntry {
  domain: string;
  email: string;
  origin: CredentialOrigin;
  /** base64(iv|tag|ciphertext) of the password. Absent when no password is stored. */
  passwordEnc?: string;
  updatedAt: string;
}

export interface SetCredentialInput {
  domain: string;
  email: string;
  /** Omit to leave an existing password untouched; "" clears it; a value (re)sets it. */
  password?: string;
  origin?: CredentialOrigin;
}

/** Stable, survives-app-deletion vault directory (home dir, NOT the app's data dir). */
export function defaultVaultDir(): string {
  const override = process.env.APPLYPILOT_CREDENTIALS_DIR?.trim();
  return override || join(homedir(), "ApplyPilot");
}

/** Normalize a domain or URL to a stable host key (so a URL and a bare host collide). */
export function credentialDomainKey(domain: string): string {
  const d = (domain || "").trim().toLowerCase();
  if (!d) return d;
  try {
    return new URL(/^https?:\/\//.test(d) ? d : `https://${d}`).host || d;
  } catch {
    return d;
  }
}

export class CredentialsVault {
  constructor(private readonly opts: { dir?: string; key?: Buffer } = {}) {}

  private get dir(): string {
    return this.opts.dir ?? defaultVaultDir();
  }
  private get filePath(): string {
    return join(this.dir, "credentials.json");
  }
  private get keyPath(): string {
    return join(this.dir, "credentials.key");
  }

  /**
   * The AES key. Order: explicit (tests) -> persisted key file (survives reinstall) -> generate and
   * persist a fresh 0600 key file. Self-provisioning means there is ALWAYS a key, so a password is
   * never written in plaintext, and the persisted key file keeps the data decryptable across a
   * delete/reinstall of the app.
   */
  private resolveKey(): Buffer {
    if (this.opts.key) return this.opts.key;
    if (existsSync(this.keyPath)) {
      try {
        const buf = Buffer.from(readFileSync(this.keyPath, "utf8").trim(), "hex");
        if (buf.length === 32) return buf;
      } catch {
        /* corrupt key file — fall through and regenerate (old data becomes unreadable, but we never
           silently downgrade to plaintext) */
      }
    }
    const key = randomBytes(32);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.keyPath, key.toString("hex"), { mode: 0o600 });
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
    return key;
  }

  location(): VaultLocation {
    return {
      dir: this.dir,
      path: this.filePath,
      keyPath: this.keyPath,
      note:
        `Your logins are saved on this device only, at ${this.filePath} (encrypted). ` +
        `That folder is in your home directory — not inside the app — so your saved logins remain ` +
        `even if you delete ApplyPilot.`,
    };
  }

  private read(): Record<string, StoredEntry> {
    const p = this.filePath;
    if (!existsSync(p)) return {};
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Record<string, StoredEntry>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, StoredEntry>): void {
    const p = this.filePath;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(p, JSON.stringify(entries), { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      /* non-POSIX filesystem */
    }
  }

  private toMeta(e: StoredEntry): CredentialMeta {
    return { domain: e.domain, email: e.email, hasPassword: Boolean(e.passwordEnc), origin: e.origin, updatedAt: e.updatedAt };
  }

  /** Save or update a login. A stored password is always AES-encrypted — never plaintext. */
  set(input: SetCredentialInput): CredentialMeta {
    const domain = credentialDomainKey(input.domain);
    if (!domain) throw new Error("A domain is required to save a login.");
    const entries = this.read();
    const prev = entries[domain];
    let passwordEnc = prev?.passwordEnc;

    if (input.password !== undefined) {
      if (input.password === "") {
        passwordEnc = undefined; // explicit clear
      } else {
        passwordEnc = encryptBytes(this.resolveKey(), Buffer.from(input.password, "utf8")).toString("base64");
      }
    }

    const entry: StoredEntry = {
      domain,
      email: input.email.trim(),
      origin: input.origin ?? prev?.origin ?? "user",
      ...(passwordEnc ? { passwordEnc } : {}),
      updatedAt: new Date().toISOString(),
    };
    entries[domain] = entry;
    this.write(entries);
    return this.toMeta(entry);
  }

  /** All saved logins as metadata — NEVER includes passwords. */
  list(): CredentialMeta[] {
    return Object.values(this.read())
      .map((e) => this.toMeta(e))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }

  getMeta(domain: string): CredentialMeta | null {
    const e = this.read()[credentialDomainKey(domain)];
    return e ? this.toMeta(e) : null;
  }

  /**
   * Decrypt the stored password for the auto-fill path. The ONLY method that returns a secret —
   * callers must NEVER log the result. Returns null when there is no entry / no password / bad key.
   */
  getPassword(domain: string): { email: string; password: string } | null {
    const e = this.read()[credentialDomainKey(domain)];
    if (!e || !e.passwordEnc) return null;
    try {
      const password = decryptBytes(this.resolveKey(), Buffer.from(e.passwordEnc, "base64")).toString("utf8");
      return { email: e.email, password };
    } catch {
      return null; // wrong/corrupt key — treat as unavailable rather than throwing on a secret path
    }
  }

  delete(domain: string): void {
    const entries = this.read();
    delete entries[credentialDomainKey(domain)];
    this.write(entries);
  }

  /** Remove the whole vault file (e.g. "forget all logins"). Leaves the key file in place. */
  wipe(): void {
    try {
      if (existsSync(this.filePath)) rmSync(this.filePath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
