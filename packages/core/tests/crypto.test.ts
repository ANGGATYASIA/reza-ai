import { describe, expect, it } from "vitest";
import { decryptSetting, encryptSetting } from "../src/index.js";

/**
 * Round-trip enkripsi AES-256-GCM untuk secret TOTP admin.
 * Memakai MASTER_KEY uji (bukan kunci produksi).
 */
const TEST_MASTER_KEY = "a".repeat(64);

describe("crypto — totpSecret terenkripsi", () => {
  it("encrypt lalu decrypt mengembalikan secret asli", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const secret = "JBSWY3DPEHPK3PXP";
    const { encryptedValue, iv } = encryptSetting(secret);
    expect(encryptedValue).not.toContain(secret);
    expect(decryptSetting(encryptedValue, iv)).toBe(secret);
  });

  it("dua enkripsi nilai sama menghasilkan ciphertext berbeda (IV acak)", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const a = encryptSetting("rahasia");
    const b = encryptSetting("rahasia");
    expect(a.encryptedValue).not.toBe(b.encryptedValue);
    expect(a.iv).not.toBe(b.iv);
  });

  it("ciphertext yang dirusak gagal didekripsi (GCM auth tag)", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const { encryptedValue, iv } = encryptSetting("rahasia");
    const raw = Buffer.from(encryptedValue, "base64");
    raw[20] ^= 0xff;
    expect(() => decryptSetting(raw.toString("base64"), iv)).toThrow();
  });

  it("tanpa MASTER_KEY valid, enkripsi menolak dengan pesan jelas", () => {
    delete process.env.MASTER_KEY;
    expect(() => encryptSetting("x")).toThrow(/MASTER_KEY/);
    process.env.MASTER_KEY = TEST_MASTER_KEY;
  });
});
