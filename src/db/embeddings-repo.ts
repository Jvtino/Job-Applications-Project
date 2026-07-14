// src/db/embeddings-repo.ts
//
// Local vector storage for semantic matching. Vectors are stored as little-endian Float32 BLOBs
// in SQLite (no external vector DB). Everything stays on this machine.

import { createHash } from "node:crypto";
import type { DB } from "./database";

/** Serialize a vector to a compact Float32 little-endian Buffer. */
export function serializeVector(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i]!, i * 4);
  return buf;
}

/** Deserialize a Float32 little-endian Buffer back into a number[]. */
export function deserializeVector(buf: Buffer): number[] {
  const n = Math.floor(buf.length / 4);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Stable hash of the text a vector was built from, so we can skip re-embedding unchanged input. */
export function sourceHash(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export interface StoredProfileEmbedding {
  vector: number[];
  model: string;
  sourceHash: string;
}

export class ProfileEmbeddingRepo {
  constructor(private readonly db: DB) {}

  get(profileId: string): StoredProfileEmbedding | null {
    const row = this.db
      .prepare("SELECT model, vector, source_hash FROM profile_embeddings WHERE profile_id = ?")
      .get(profileId) as { model: string; vector: Buffer; source_hash: string } | undefined;
    if (!row) return null;
    return { vector: deserializeVector(row.vector), model: row.model, sourceHash: row.source_hash };
  }

  set(profileId: string, model: string, vector: number[], hash: string): void {
    this.db
      .prepare(
        `INSERT INTO profile_embeddings (profile_id, model, dims, vector, source_hash, updated_at)
         VALUES (@profile_id, @model, @dims, @vector, @source_hash, @updated_at)
         ON CONFLICT(profile_id) DO UPDATE SET
           model = excluded.model, dims = excluded.dims, vector = excluded.vector,
           source_hash = excluded.source_hash, updated_at = excluded.updated_at`
      )
      .run({
        profile_id: profileId,
        model,
        dims: vector.length,
        vector: serializeVector(vector),
        source_hash: hash,
        updated_at: new Date().toISOString(),
      });
  }
}

/** Read/write a discovered job's cached description embedding by job id. */
export class JobEmbeddingRepo {
  constructor(private readonly db: DB) {}

  get(jobId: string): { vector: number[]; model: string } | null {
    const row = this.db
      .prepare("SELECT embedding, embedding_model FROM discovered_jobs WHERE id = ?")
      .get(jobId) as { embedding: Buffer | null; embedding_model: string | null } | undefined;
    if (!row?.embedding || !row.embedding_model) return null;
    return { vector: deserializeVector(row.embedding), model: row.embedding_model };
  }

  set(jobId: string, model: string, vector: number[]): void {
    this.db
      .prepare("UPDATE discovered_jobs SET embedding = ?, embedding_model = ? WHERE id = ?")
      .run(serializeVector(vector), model, jobId);
  }
}
