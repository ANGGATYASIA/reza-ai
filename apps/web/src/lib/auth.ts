import { randomBytes } from "node:crypto";
import { generateSecret as otpGenerateSecret, generateSync, generateURI, verifySync } from "otplib";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type Redis from "ioredis";
import { prisma, decryptSetting, encryptSetting } from "@reza-ai/core";

// ============================================================
// Reza AI — logika autentikasi admin.
// Semua fungsi menerima klien Redis sebagai parameter (dependency
// injection) supaya bisa diuji dengan ioredis-mock tanpa server.
// Helper khusus Next.js (cookies/request) ada di auth-server.ts
// dan dipakai langsung oleh Route Handler + Server Component.
// Task berikutnya (settings, dst.) cukup memanggil requireAdmin().
// ============================================================


export const SESSION_COOKIE = "reza_session";
export const PREAUTH_COOKIE = "reza_preauth";
export const SETUP_COOKIE = "reza_setup";

export const SESSION_TTL_SEC = 12 * 3600; // 12 jam, sliding
export const PREAUTH_TTL_SEC = 5 * 60; // 5 menit (langkah 1 -> 2 login)
export const SETUP_TTL_SEC = 15 * 60; // 15 menit (wizard /setup)

export const LOGIN_RATE_LIMIT_MAX = 5;
export const LOGIN_RATE_LIMIT_WINDOW_SEC = 15 * 60;

/** Toleransi verifikasi TOTP: ±30 detik (±1 langkah waktu). */
export const TOTP_WINDOW_SEC = 30;

const sessionKey = (token: string) => `reza:session:${token}`;
const preAuthKey = (token: string) => `reza:preauth:${token}`;
const setupKey = (token: string) => `reza:setup:${token}`;
const setupTotpKey = (setupToken: string) => `reza:setup:totp:${setupToken}`;
const rateLimitKey = (ip: string) => `reza:ratelimit:login:${ip}`;

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Opsi cookie sesi: httpOnly, Secure saat production, SameSite=Lax. */
export function sessionCookieOptions(maxAgeSec: number = SESSION_TTL_SEC) {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSec,
  };
}

export function clearCookieOptions() {
  return { ...sessionCookieOptions(0), maxAge: 0 };
}

// ---------------- Sesi (opaque token di Redis) ----------------

/**
 * Keputusan desain (didokumentasikan): sesi memakai opaque token acak
 * yang disimpan di Redis (`reza:session:<token>` -> adminId, TTL 12 jam),
 * BUKAN JWT. Alasannya:
 * 1. Revokasi instan — logout / pemutusan paksa cukup menghapus key;
 *    JWT butuh denylist yang ujung-ujungnya tetap memakai Redis.
 * 2. Sliding expiry trivial: setiap request valid memperpanjang TTL.
 * 3. Tidak ada masalah rotasi secret; token tidak membawa data sensitif.
 * 4. Redis sudah dependensi wajib (rate limit, queue), jadi tidak ada
 *    infrastruktur tambahan. Biaya: 1 GET Redis per request (~sub-ms).
 */
export async function createSession(redis: Redis, adminId: string): Promise<string> {
  const token = newOpaqueToken();
  await redis.set(sessionKey(token), adminId, "EX", SESSION_TTL_SEC);
  return token;
}

/**
 * Validasi token sesi. Mengembalikan adminId bila valid, sekaligus
 * memperpanjang TTL (sliding session). Null bila token tidak dikenal.
 */
export async function getSessionAdminId(redis: Redis, token: string): Promise<string | null> {
  if (!token) return null;
  const adminId = await redis.get(sessionKey(token));
  if (!adminId) return null;
  await redis.expire(sessionKey(token), SESSION_TTL_SEC);
  return adminId;
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  if (!token) return;
  await redis.del(sessionKey(token));
}

// ---------------- Token pra-autentikasi (login langkah 1 -> 2) ----------------

export async function createPreAuth(redis: Redis, adminId: string): Promise<string> {
  const token = newOpaqueToken();
  await redis.set(preAuthKey(token), adminId, "EX", PREAUTH_TTL_SEC);
  return token;
}

export async function getPreAuthAdminId(redis: Redis, token: string): Promise<string | null> {
  if (!token) return null;
  return redis.get(preAuthKey(token));
}

export async function destroyPreAuth(redis: Redis, token: string): Promise<void> {
  if (!token) return;
  await redis.del(preAuthKey(token));
}

// ---------------- Token wizard /setup ----------------

export async function createSetupToken(redis: Redis, adminId: string): Promise<string> {
  const token = newOpaqueToken();
  await redis.set(setupKey(token), adminId, "EX", SETUP_TTL_SEC);
  return token;
}

export async function getSetupAdminId(redis: Redis, token: string): Promise<string | null> {
  if (!token) return null;
  return redis.get(setupKey(token));
}

export async function destroySetupToken(redis: Redis, token: string): Promise<void> {
  if (!token) return;
  await redis.del([setupKey(token), setupTotpKey(token)]);
}

/** Secret TOTP yang belum terverifikasi — disimpan di Redis, BELUM di DB. */
export async function stashSetupTotpSecret(
  redis: Redis,
  setupToken: string,
  secret: string,
): Promise<void> {
  await redis.set(setupTotpKey(setupToken), secret, "EX", SETUP_TTL_SEC);
}

export async function takeSetupTotpSecret(
  redis: Redis,
  setupToken: string,
): Promise<string | null> {
  return redis.get(setupTotpKey(setupToken));
}

// ---------------- Rate limit login ----------------

export function getClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Cek rate limit login per IP. Batasan: 5 kegagalan per 15 menit.
 * Mengembalikan { allowed } + sisa detik tunggu bila diblokir.
 */
export async function checkLoginAllowed(
  redis: Redis,
  ip: string,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const count = Number((await redis.get(rateLimitKey(ip))) ?? 0);
  if (count >= LOGIN_RATE_LIMIT_MAX) {
    const ttl = await redis.ttl(rateLimitKey(ip));
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : LOGIN_RATE_LIMIT_WINDOW_SEC };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export async function recordLoginFailure(redis: Redis, ip: string): Promise<void> {
  const count = await redis.incr(rateLimitKey(ip));
  if (count === 1) {
    await redis.expire(rateLimitKey(ip), LOGIN_RATE_LIMIT_WINDOW_SEC);
  }
}

export async function resetLoginRateLimit(redis: Redis, ip: string): Promise<void> {
  await redis.del(rateLimitKey(ip));
}

export const RATE_LIMIT_MESSAGE = "Terlalu banyak percobaan, coba lagi dalam 15 menit.";

// ---------------- TOTP (otplib v13, functional API) ----------------

export function generateTotpSecret(): string {
  return otpGenerateSecret();
}

export function totpAuthUrl(email: string, secret: string): string {
  const issuer = process.env.TOTP_ISSUER || "Reza AI";
  return generateURI({ issuer, label: email, secret });
}

/** Buat kode TOTP untuk secret; epochSec opsional (detik, untuk pengujian). */
export function generateTotpToken(secret: string, epochSec?: number): string {
  return epochSec === undefined
    ? generateSync({ secret })
    : generateSync({ secret, epoch: epochSec });
}

/** Verifikasi kode 6 digit dengan toleransi ±1 langkah waktu. */
export function verifyTotpToken(secret: string, token: string): boolean {
  try {
    const result = verifySync({
      secret,
      token: token.trim(),
      epochTolerance: TOTP_WINDOW_SEC,
    });
    return result.valid === true;
  } catch {
    return false;
  }
}

// ---------------- Penyimpanan secret TOTP terenkripsi ----------------

/**
 * Secret TOTP disimpan di kolom Admin.totpSecret dalam keadaan
 * TERENKRIPSI (AES-256-GCM via @reza-ai/core), dikemas sebagai JSON
 * { encryptedValue, iv }. Plaintext secret tidak pernah menyentuh DB.
 */
export function packTotpSecret(secret: string): string {
  const { encryptedValue, iv } = encryptSetting(secret);
  return JSON.stringify({ encryptedValue, iv });
}

/** Kembalikan secret plaintext dari kemasan terenkripsi. */
export function unpackTotpSecret(packed: string): string {
  const { encryptedValue, iv } = JSON.parse(packed) as {
    encryptedValue: string;
    iv: string;
  };
  return decryptSetting(encryptedValue, iv);
}

// ---------------- Token re-enroll 2FA (admin lama tanpa TOTP) ----------------

const reenrollTotpKey = (preAuthToken: string) => `reza:reenroll:totp:${preAuthToken}`;

export async function stashReenrollTotpSecret(
  redis: Redis,
  preAuthToken: string,
  secret: string,
): Promise<void> {
  await redis.set(reenrollTotpKey(preAuthToken), secret, "EX", PREAUTH_TTL_SEC);
}

export async function takeReenrollTotpSecret(
  redis: Redis,
  preAuthToken: string,
): Promise<string | null> {
  return redis.get(reenrollTotpKey(preAuthToken));
}

export async function destroyReenrollTotpSecret(
  redis: Redis,
  preAuthToken: string,
): Promise<void> {
  await redis.del(reenrollTotpKey(preAuthToken));
}

// ---------------- requireAdmin — dipakai setiap Route Handler ----------------

export interface AdminIdentity {
  id: string;
  email: string;
}

const UNAUTHORIZED_MESSAGE = "Sesi berakhir atau tidak valid. Masuk kembali.";

async function loadAdminIdentity(
  db: AdminReader,
  adminId: string,
): Promise<AdminIdentity | null> {
  const admin = await db.admin.findUnique({
    where: { id: adminId },
    select: { id: true, email: true },
  });
  return admin;
}

/** Reader minimal yang dibutuhkan requireAdmin — PrismaClient asli memenuhinya. */
export interface AdminReader {
  admin: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; email: true };
    }): Promise<AdminIdentity | null>;
  };
}

export type RequireAdminResult =
  | { ok: true; admin: AdminIdentity }
  | { ok: false; response: NextResponse };

/**
 * Penjaga otorisasi untuk Route Handler. Cara pakai:
 *
 *   const auth = await requireAdmin(req);
 *   if (!auth.ok) return auth.response; // 401 otomatis
 *   const admin = auth.admin;
 *
 * Validasi bersifat otoritatif: token dicek ke Redis, lalu admin
 * dipastikan masih ada di database. Parameter `db` opsional untuk
 * pengujian (default: prisma asli).
 */
export async function requireAdmin(
  req: NextRequest,
  redis: Redis,
  db: AdminReader = prisma,
): Promise<RequireAdminResult> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return {
      ok: false,
      response: NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 }),
    };
  }
  const adminId = await getSessionAdminId(redis, token);
  if (!adminId) {
    return {
      ok: false,
      response: NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 }),
    };
  }
  const admin = await loadAdminIdentity(db, adminId);
  if (!admin) {
    await destroySession(redis, token);
    return {
      ok: false,
      response: NextResponse.json({ error: UNAUTHORIZED_MESSAGE }, { status: 401 }),
    };
  }
  return { ok: true, admin };
}

/**
 * Varian ringan tanpa DB: hanya validasi token -> adminId.
 * Dipakai halaman server yang hanya butuh tahu sesi valid.
 */
export async function getSessionAdminIdFromRequest(
  req: NextRequest,
  redis: Redis,
): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return getSessionAdminId(redis, token ?? "");
}
