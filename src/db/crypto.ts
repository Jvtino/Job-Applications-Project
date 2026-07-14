// src/db/crypto.ts
//
// AES-256-GCM encryption-at-rest for the local datastore. Profile + ledger JSON blobs are
// the most sensitive PII in the app (self-ID, disability, veteran status). When an
// encryption key is configured, payloads are encrypted before they ever touch disk.
//
// Stored layout (single Buffer):  [ iv(12) | authTag(16) | ciphertext(...) ]

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptBytes(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptBytes(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error("Ciphertext too short / corrupt.");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Serialize a JS value for storage. With a key: encrypted Buffer. Without: plain UTF-8 JSON
 * (Buffer). The accompanying `enc` flag (stored alongside) records which form was used so
 * reads can round-trip correctly even if the key is added/removed later.
 */
export function serializeForStorage(
  value: unknown,
  key: Buffer | undefined
): { data: Buffer; enc: 0 | 1 } {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (!key) return { data: json, enc: 0 };
  return { data: encryptBytes(key, json), enc: 1 };
}

export function deserializeFromStorage<T>(
  data: Buffer,
  enc: 0 | 1,
  key: Buffer | undefined
): T {
  if (enc === 1) {
    if (!key) {
      throw new Error(
        "Stored data is encrypted but APPLYPILOT_ENCRYPTION_KEY is not set. " +
          "Set the same key used to write it."
      );
    }
    const json = decryptBytes(key, data);
    return JSON.parse(json.toString("utf8")) as T;
  }
  return JSON.parse(data.toString("utf8")) as T;
}
