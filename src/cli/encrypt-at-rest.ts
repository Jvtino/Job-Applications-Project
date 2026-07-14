// CLI: encrypt existing plaintext profile + ledger rows at rest (AES-256-GCM).
//
// Safe + idempotent:
//   * requires APPLYPILOT_ENCRYPTION_KEY (32-byte hex/base64) — refuses to run without it;
//   * backs up the database file before touching anything;
//   * re-encrypts only enc=0 rows (already-encrypted rows are skipped), inside a transaction;
//   * verifies each row round-trips (decrypts back to the same JSON) before committing.
//
// The per-row `enc` flag means reads keep working throughout, even if the run is interrupted.
//
//   npm run encrypt-at-rest
//
// NOTE: the key lives in .env on this same machine, so this protects a stolen *database file*
// (copied without .env), not a fully compromised machine. Keep the key backed up — without it the
// encrypted data cannot be recovered.

import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config";
import { openDatabase } from "../db/database";
import { serializeForStorage, deserializeFromStorage } from "../db/crypto";

const PII_TABLES = [
  { name: "profiles", key: "id" },
  { name: "ledgers", key: "profile_id" },
] as const;

interface Row {
  pk: string;
  data: Buffer | string;
  enc: number;
}

function main(): void {
  const cfg = loadConfig();
  const key = cfg.encryptionKey;
  if (!key) {
    console.error(
      "APPLYPILOT_ENCRYPTION_KEY is not set, so there is nothing to encrypt with.\n" +
        "Generate a key, add it to .env as APPLYPILOT_ENCRYPTION_KEY, then re-run this command:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
    process.exit(1);
  }

  const dbPath = resolve(cfg.dbPath);
  const backup = `${dbPath}.pre-encrypt-${Date.now()}.bak`;
  copyFileSync(dbPath, backup);
  console.log(`Backed up database → ${backup}`);

  const db = openDatabase(dbPath);
  let total = 0;
  try {
    for (const table of PII_TABLES) {
      const rows = db
        .prepare(`SELECT "${table.key}" AS pk, data, enc FROM "${table.name}" WHERE enc = 0`)
        .all() as Row[];
      const update = db.prepare(`UPDATE "${table.name}" SET data = @data, enc = 1 WHERE "${table.key}" = @pk`);
      const tx = db.transaction((batch: Row[]) => {
        for (const r of batch) {
          const plaintext = Buffer.isBuffer(r.data) ? r.data.toString("utf8") : String(r.data);
          const value = JSON.parse(plaintext);
          const { data, enc } = serializeForStorage(value, key);
          // Verify the row round-trips with this key before we overwrite the plaintext.
          const check = deserializeFromStorage(data, enc, key);
          if (JSON.stringify(check) !== JSON.stringify(value)) {
            throw new Error(`Round-trip verification failed for ${table.name}/${r.pk}; aborting (no rows changed).`);
          }
          update.run({ pk: r.pk, data });
        }
      });
      tx(rows);
      total += rows.length;
      console.log(`  ${table.name}: encrypted ${rows.length} plaintext row(s)`);
    }
  } finally {
    db.close();
  }

  console.log(
    `\nDone — encrypted ${total} row(s). Keep APPLYPILOT_ENCRYPTION_KEY safe: without it this data ` +
      `cannot be read. Backup left at ${backup} (delete once you've confirmed the app still loads).`
  );
}

main();
