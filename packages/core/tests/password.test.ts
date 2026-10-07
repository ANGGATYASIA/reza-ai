import { describe, expect, it } from "vitest";
import {
  hashPassword,
  validateEmail,
  validatePasswordStrength,
  verifyPassword,
} from "../src/index.js";

/**
 * Test kriptografi kata sandi admin (Argon2id asli, bukan mock):
 * hash -> verify benar/salah, plus aturan validasi form.
 */
describe("argon2 — hash & verify", () => {
  it("kata sandi benar lolos verifikasi", async () => {
    const hash = await hashPassword("KataSandiRahasia123");
    expect(await verifyPassword(hash, "KataSandiRahasia123")).toBe(true);
  });

  it("kata sandi salah ditolak (tanpa throw)", async () => {
    const hash = await hashPassword("KataSandiRahasia123");
    expect(await verifyPassword(hash, "salah-sekali")).toBe(false);
  });

  it("hash rusak ditolak tanpa throw", async () => {
    expect(await verifyPassword("bukan-hash-valid", "apa-saja")).toBe(false);
  });

  it("dua hash dari kata sandi sama berbeda (salt acak)", async () => {
    const a = await hashPassword("sama-sama-aman-123");
    const b = await hashPassword("sama-sama-aman-123");
    expect(a).not.toBe(b);
  });
});

describe("validatePasswordStrength", () => {
  it("menolak kata sandi < 12 karakter", () => {
    expect(validatePasswordStrength("pendek123")).toBe("Kata sandi minimal 12 karakter.");
  });

  it("menerima kata sandi >= 12 karakter", () => {
    expect(validatePasswordStrength("cukup-panjang-123")).toBeNull();
  });
});

describe("validateEmail", () => {
  it("menerima email valid", () => {
    expect(validateEmail("admin@granddutacity.id")).toBe(true);
  });

  it("menolak format salah", () => {
    expect(validateEmail("bukan-email")).toBe(false);
    expect(validateEmail("tanpa@domain")).toBe(false);
    expect(validateEmail("")).toBe(false);
  });
});
