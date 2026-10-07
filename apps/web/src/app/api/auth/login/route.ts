import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hashPassword, verifyPassword } from "@reza-ai/core";
import {
  PREAUTH_COOKIE,
  PREAUTH_TTL_SEC,
  RATE_LIMIT_MESSAGE,
  checkLoginAllowed,
  createPreAuth,
  getClientIp,
  recordLoginFailure,
  resetLoginRateLimit,
  sessionCookieOptions,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

const GENERIC_FAIL = "Email atau kata sandi salah.";

// Hash dummy agar waktu respons untuk email tak dikenal mirip dengan
// email terdaftar (anti user-enumeration via timing).
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHash) dummyHash = await hashPassword("kata-sandi-dummy-tidak-pernah-cocok");
  return dummyHash;
}

interface LoginBody {
  email?: string;
  password?: string;
}

/**
 * POST /api/auth/login — langkah 1: email + kata sandi.
 * Sukses -> cookie pra-autentikasi (5 menit) + { next: "totp" | "enroll-2fa" }.
 * Gagal -> 401 dengan pesan generik (tanpa membocorkan mana yang salah).
 */
export async function POST(req: NextRequest) {
  const redis = getRedis();
  const ip = getClientIp(req.headers);

  const { allowed, retryAfterSec } = await checkLoginAllowed(redis, ip);
  if (!allowed) {
    const res = NextResponse.json({ error: RATE_LIMIT_MESSAGE }, { status: 429 });
    res.headers.set("Retry-After", String(retryAfterSec));
    return res;
  }

  let body: LoginBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 401 });
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const admin = email ? await prisma.admin.findUnique({ where: { email } }) : null;
  const passwordOk = admin
    ? await verifyPassword(admin.passwordHash, password)
    : await verifyPassword(await getDummyHash(), password);

  if (!admin || !passwordOk) {
    await recordLoginFailure(redis, ip);
    return NextResponse.json({ error: GENERIC_FAIL }, { status: 401 });
  }

  await resetLoginRateLimit(redis, ip);
  const preAuthToken = await createPreAuth(redis, admin.id);

  const res = NextResponse.json({
    ok: true,
    next: admin.totpSecret ? "totp" : "enroll-2fa",
  });
  res.cookies.set(PREAUTH_COOKIE, preAuthToken, sessionCookieOptions(PREAUTH_TTL_SEC));
  return res;
}
