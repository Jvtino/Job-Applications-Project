// src/db/accounts-repo.ts
//
// Tracks which career sites require an account — METADATA ONLY. ApplyPilot never stores a
// password: there is no password field on this record and no method that accepts one. The
// `passwordStore` label just records WHERE the user saved it (e.g. "1Password"), so the app can
// remind the user to log in (vs. register) next time and pause for them.

import { randomUUID } from "node:crypto";
import type { DB } from "./database";

export interface AccountRecord {
  id: string;
  profileId: string;
  domain: string;
  /** The email/username the user uses on this site (NOT a secret). */
  username?: string;
  accountExists: boolean;
  /** The persistent browser session is currently authenticated for this site (NOT a credential). */
  loggedIn: boolean;
  lastLoginAt?: string;
  /** Free-text pointer to where the user saved the password (never the password itself). */
  passwordStore?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  profile_id: string;
  domain: string;
  username: string | null;
  account_exists: number;
  logged_in: number;
  last_login_at: string | null;
  password_store: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(r: Row): AccountRecord {
  return {
    id: r.id,
    profileId: r.profile_id,
    domain: r.domain,
    ...(r.username ? { username: r.username } : {}),
    accountExists: r.account_exists === 1,
    loggedIn: r.logged_in === 1,
    ...(r.last_login_at ? { lastLoginAt: r.last_login_at } : {}),
    ...(r.password_store ? { passwordStore: r.password_store } : {}),
    ...(r.notes ? { notes: r.notes } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class AccountsRepo {
  constructor(private readonly db: DB) {}

  get(profileId: string, domain: string): AccountRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM accounts WHERE profile_id = ? AND domain = ?")
      .get(profileId, domain) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }

  list(profileId: string): AccountRecord[] {
    return (
      this.db.prepare("SELECT * FROM accounts WHERE profile_id = ? ORDER BY updated_at DESC").all(profileId) as Row[]
    ).map(toRecord);
  }

  /**
   * Record (or refresh) that a site needs an account. Accepts ONLY non-secret metadata — there
   * is deliberately no password parameter.
   */
  upsert(input: {
    profileId: string;
    domain: string;
    username?: string;
    accountExists?: boolean;
    passwordStore?: string;
    notes?: string;
  }): AccountRecord {
    const existing = this.get(input.profileId, input.domain);
    const now = new Date().toISOString();
    const rec: AccountRecord = {
      id: existing?.id ?? randomUUID(),
      profileId: input.profileId,
      domain: input.domain,
      ...(input.username ?? existing?.username ? { username: input.username ?? existing?.username } : {}),
      accountExists: input.accountExists ?? existing?.accountExists ?? false,
      loggedIn: existing?.loggedIn ?? false,
      ...(existing?.lastLoginAt ? { lastLoginAt: existing.lastLoginAt } : {}),
      ...(input.passwordStore ?? existing?.passwordStore ? { passwordStore: input.passwordStore ?? existing?.passwordStore } : {}),
      ...(input.notes ?? existing?.notes ? { notes: input.notes ?? existing?.notes } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO accounts (id, profile_id, domain, username, account_exists, logged_in, last_login_at, password_store, notes, created_at, updated_at)
         VALUES (@id, @profile_id, @domain, @username, @account_exists, @logged_in, @last_login_at, @password_store, @notes, @created_at, @updated_at)
         ON CONFLICT(profile_id, domain) DO UPDATE SET
           username = excluded.username, account_exists = excluded.account_exists,
           password_store = excluded.password_store, notes = excluded.notes, updated_at = excluded.updated_at`
      )
      .run({
        id: rec.id,
        profile_id: rec.profileId,
        domain: rec.domain,
        username: rec.username ?? null,
        account_exists: rec.accountExists ? 1 : 0,
        logged_in: rec.loggedIn ? 1 : 0,
        last_login_at: rec.lastLoginAt ?? null,
        password_store: rec.passwordStore ?? null,
        notes: rec.notes ?? null,
        created_at: rec.createdAt,
        updated_at: rec.updatedAt,
      });
    return rec;
  }

  /** Record that the persistent browser session is now authenticated for this site. */
  markLoggedIn(profileId: string, domain: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE accounts SET logged_in = 1, account_exists = 1, last_login_at = ?, updated_at = ? WHERE profile_id = ? AND domain = ?")
      .run(now, now, profileId, domain);
  }

  /** Record that the session is no longer authenticated (a login wall appeared again). */
  markNeedsLogin(profileId: string, domain: string): void {
    this.db
      .prepare("UPDATE accounts SET logged_in = 0, updated_at = ? WHERE profile_id = ? AND domain = ?")
      .run(new Date().toISOString(), profileId, domain);
  }

  /** True if we have a live, authenticated session for this site (auto mode can reuse it). */
  isSessionReady(profileId: string, domain: string): boolean {
    return this.get(profileId, domain)?.loggedIn ?? false;
  }
}
