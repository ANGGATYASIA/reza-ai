import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

function masterKey(): Buffer {
  const hex = process.env.MASTER_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "MASTER_KEY harus 32 byte dalam format hex (64 karakter). " +
        "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

/**
 * Enkripsi nilai setting (mis. API key) dengan AES-256-GCM.
 * Kembalikan { encryptedValue, iv } untuk disimpan di tabel Setting.
 */
export function encryptSetting(plaintext: string): { encryptedValue: string; iv: string } {
  const key = masterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryptedValue: Buffer.concat([tag, ciphertext]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

/** Dekripsi nilai dari tabel Setting. */
export function decryptSetting(encryptedValue: string, iv: string): string {
  const key = masterKey();
  const raw = Buffer.from(encryptedValue, "base64");
  const tag = raw.subarray(0, 16);
  const ciphertext = raw.subarray(16);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
