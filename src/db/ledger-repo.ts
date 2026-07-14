// src/db/ledger-repo.ts
//
// Persistence for the Module 2 facts ledger — kept DELIBERATELY SEPARATE from the profile
// store (document generation reads the ledger; auto-fill reads the profile). Validates in
// and out with the Zod schema pinned to the canonical type.

import type { DB } from "./database";
import { recordAudit } from "./database";
import { deserializeFromStorage, serializeForStorage } from "./crypto";
import { factsLedgerSchema } from "../validation/facts-ledger.schema";
import type { FactsLedger } from "../types/facts-ledger";

interface LedgerRow {
  profile_id: string;
  data: Buffer;
  enc: number;
  updated_at: string;
}

export class LedgerRepo {
  constructor(
    private readonly db: DB,
    private readonly encryptionKey: Buffer | undefined
  ) {}

  save(ledger: FactsLedger): FactsLedger {
    const validated = factsLedgerSchema.parse(ledger);
    const { data, enc } = serializeForStorage(validated, this.encryptionKey);
    this.db
      .prepare(
        `INSERT INTO ledgers (profile_id, data, enc, updated_at)
         VALUES (@profile_id, @data, @enc, @updated_at)
         ON CONFLICT(profile_id) DO UPDATE SET
           data       = excluded.data,
           enc        = excluded.enc,
           updated_at = excluded.updated_at`
      )
      .run({
        profile_id: validated.profileId,
        data,
        enc,
        updated_at: new Date().toISOString(),
      });
    recordAudit(this.db, validated.profileId, "ledger.save", {
      factCount: validated.facts.length,
      approvedCount: validated.facts.filter((f) => f.approved).length,
    });
    return validated;
  }

  get(profileId: string): FactsLedger | undefined {
    const row = this.db
      .prepare("SELECT * FROM ledgers WHERE profile_id = ?")
      .get(profileId) as LedgerRow | undefined;
    if (!row) return undefined;
    const raw = deserializeFromStorage<unknown>(
      row.data,
      row.enc === 1 ? 1 : 0,
      this.encryptionKey
    );
    return factsLedgerSchema.parse(raw);
  }
}
