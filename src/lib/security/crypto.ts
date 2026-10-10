import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the few fields we must hold briefly (traveller names between checkout and the purchase call).
 * Key: PASSENGER_DATA_KEY = 32 random bytes, base64 (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
 * Output layout: [12-byte IV][16-byte auth tag][ciphertext]. Any tampering makes decrypt() throw.
 */
export function loadKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.PASSENGER_DATA_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PASSENGER_DATA_KEY must be 32 random bytes, base64-encoded.");
  return key;
}

export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (blob.length < 29) throw new Error("Ciphertext too short.");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}
