import Redis from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  checkLoginAllowed,
  createPreAuth,
  createSession,
  createSetupToken,
  destroyPreAuth,
  destroySession,
  destroySetupToken,
  generateTotpSecret,
  generateTotpToken,
  getPreAuthAdminId,
  getSessionAdminId,
  getSetupAdminId,
  packTotpSecret,
  recordLoginFailure,
  resetLoginRateLimit,
  sessionCookieOptions,
  stashSetupTotpSecret,
  takeSetupTotpSecret,
  totpAuthUrl,
  unpackTotpSecret,
  verifyTotpToken,
} from "../src/lib/auth.js";

let redis: InstanceType<typeof Redis>;

beforeEach(() => {
  redis = new Redis();
});

afterEach(() => {
  redis.disconnect();
});

// ---------------- (b) TOTP ----------------

describe("TOTP — kode valid diterima, salah/kedaluwarsa ditolak", () => {
  it("kode yang baru dibuat lolos verifikasi", () => {
    const secret = generateTotpSecret();
    const code = generateTotpToken(secret);
    expect(verifyTotpToken(secret, code)).toBe(true);
  });

  it("kode salah ditolak", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpToken(secret, "000000")).toBe(false);
    expect(verifyTotpToken(secret, "")).toBe(false);
  });

  it("kode di luar window (±1 langkah) ditolak", () => {
    const secret = generateTotpSecret();
    // Kode dari 3 menit lalu (6 langkah) — di luar toleransi ±30 detik.
    const stale = generateTotpToken(secret, Math.floor(Date.now() / 1000) - 180);
    expect(verifyTotpToken(secret, stale)).toBe(false);
  });

  it("kode 1 langkah ke depan masih diterima (window toleransi)", () => {
    const secret = generateTotpSecret();
    const ahead = generateTotpToken(secret, Math.floor(Date.now() / 1000) + 30);
    expect(verifyTotpToken(secret, ahead)).toBe(true);
  });

  it("otpauth URL memuat issuer dan email", () => {
    const url = totpAuthUrl("admin@example.id", "JBSWY3DPEHPK3PXP");
    expect(url).toContain("otpauth://totp/");
    expect(url).toContain(encodeURIComponent("Reza AI (test)"));
    expect(url).toContain("admin%40example.id");
  });
});

// ---------------- Secret TOTP terenkripsi ----------------

describe("pack/unpack — secret TOTP terenkripsi di DB", () => {
  it("round-trip mengembalikan secret asli; plaintext tak terlihat", () => {
    const secret = generateTotpSecret();
    const packed = packTotpSecret(secret);
    expect(packed).not.toContain(secret);
    expect(unpackTotpSecret(packed)).toBe(secret);
  });
});

// ---------------- (c) Rate limit ----------------

describe("rate limit login — 5 gagal per 15 menit", () => {
  const ip = "203.0.113.7";

  it("awalnya diizinkan", async () => {
    expect(await checkLoginAllowed(redis, ip)).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it("5 kegagalan -> percobaan berikutnya diblokir (429)", async () => {
    // 4 kegagalan pertama: masih boleh mencoba.
    for (let i = 0; i < 4; i++) {
      await recordLoginFailure(redis, ip);
      expect((await checkLoginAllowed(redis, ip)).allowed).toBe(true);
    }
    // Kegagalan ke-5: jatah habis, percobaan berikutnya ditolak.
    await recordLoginFailure(redis, ip);
    const blocked = await checkLoginAllowed(redis, ip);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(15 * 60);
  });

  it("login sukses me-reset counter", async () => {
    for (let i = 0; i < 5; i++) await recordLoginFailure(redis, ip);
    await resetLoginRateLimit(redis, ip);
    expect(await checkLoginAllowed(redis, ip)).toEqual({ allowed: true, retryAfterSec: 0 });
  });

  it("IP berbeda punya counter sendiri", async () => {
    for (let i = 0; i < 6; i++) await recordLoginFailure(redis, ip);
    expect((await checkLoginAllowed(redis, "198.51.100.9")).allowed).toBe(true);
  });
});

// ---------------- Sesi, pre-auth, setup token ----------------

describe("sesi opaque di Redis", () => {
  it("create -> get mengembalikan adminId + sliding TTL", async () => {
    const token = await createSession(redis, "admin-1");
    expect(token.length).toBeGreaterThan(32);
    expect(await getSessionAdminId(redis, token)).toBe("admin-1");
    const ttl = await redis.ttl(`reza:session:${token}`);
    expect(ttl).toBeGreaterThan(11 * 3600);
    expect(ttl).toBeLessThanOrEqual(12 * 3600);
  });

  it("token tak dikenal -> null", async () => {
    expect(await getSessionAdminId(redis, "token-ngawur")).toBeNull();
    expect(await getSessionAdminId(redis, "")).toBeNull();
  });

  it("destroy menghapus sesi (logout)", async () => {
    const token = await createSession(redis, "admin-1");
    await destroySession(redis, token);
    expect(await getSessionAdminId(redis, token)).toBeNull();
  });

  it("dua sesi admin sama memakai token berbeda", async () => {
    const a = await createSession(redis, "admin-1");
    const b = await createSession(redis, "admin-1");
    expect(a).not.toBe(b);
    await destroySession(redis, a);
    expect(await getSessionAdminId(redis, b)).toBe("admin-1");
  });
});

describe("token pra-autentikasi & setup", () => {
  it("pre-auth hidup 5 menit lalu bisa dihancurkan", async () => {
    const t = await createPreAuth(redis, "admin-1");
    expect(await getPreAuthAdminId(redis, t)).toBe("admin-1");
    expect(await redis.ttl(`reza:preauth:${t}`)).toBeLessThanOrEqual(5 * 60);
    await destroyPreAuth(redis, t);
    expect(await getPreAuthAdminId(redis, t)).toBeNull();
  });

  it("setup token + stash secret TOTP sementara", async () => {
    const t = await createSetupToken(redis, "admin-1");
    expect(await getSetupAdminId(redis, t)).toBe("admin-1");
    await stashSetupTotpSecret(redis, t, "RAHASIA123");
    expect(await takeSetupTotpSecret(redis, t)).toBe("RAHASIA123");
    await destroySetupToken(redis, t);
    expect(await getSetupAdminId(redis, t)).toBeNull();
    expect(await takeSetupTotpSecret(redis, t)).toBeNull();
  });
});

// ---------------- Opsi cookie ----------------

describe("sessionCookieOptions", () => {
  it("httpOnly, SameSite=Lax, Path=/, maxAge 12 jam", () => {
    const opts = sessionCookieOptions();
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(12 * 3600);
    // Di test (NODE_ENV != production), Secure mati agar E2E lokal jalan.
    expect(opts.secure).toBe(false);
  });
});

// SESSION_COOKIE diimpor agar typo nama cookie ketahuan saat compile.
it("nama cookie sesi konsisten", () => {
  expect(SESSION_COOKIE).toBe("reza_session");
});
