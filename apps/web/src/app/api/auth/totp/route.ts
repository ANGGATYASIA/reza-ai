import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PREAUTH_COOKIE,
  RATE_LIMIT_MESSAGE,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  checkLoginAllowed,
  createSession,
  destroyPreAuth,
  getClientIp,
  getPreAuthAdminId,
  recordLoginFailure,
  resetLoginRateLimit,
  sessionCookieOptions,
  unpackTotpSecret,
  verifyTotpToken,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

interface TotpBody {
  code?: string;
}

/**
 * POST /api/auth/totp — langkah 2: kode 6 digit dari aplikasi autentikator.
 * Butuh cookie pra-autentikasi dari langkah 1. Sukses -> cookie sesi 12 jam.
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

  const preAuthToken = req.cookies.get(PREAUTH_COOKIE)?.value;
  const adminId = await getPreAuthAdminId(redis, preAuthToken ?? "");
  if (!adminId) {
    return NextResponse.json(
      { error: "Sesi verifikasi kedaluwarsa. Masuk kembali dari awal." },
      { status: 401 },
    );
  }

  let body: TotpBody;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const code = (body.code ?? "").trim();

  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  let codeOk = false;
  if (admin?.totpSecret) {
    try {
      codeOk = verifyTotpToken(unpackTotpSecret(admin.totpSecret), code);
    } catch {
      codeOk = false;
    }
  }

  if (!codeOk) {
    await recordLoginFailure(redis, ip);
    return NextResponse.json(
      { error: "Kode verifikasi salah. Periksa aplikasi autentikator lalu coba lagi." },
      { status: 401 },
    );
  }

  await destroyPreAuth(redis, preAuthToken ?? "");
  await resetLoginRateLimit(redis, ip);
  const sessionToken = await createSession(redis, admin!.id);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions(SESSION_TTL_SEC));
  // Bersihkan cookie pra-autentikasi yang sudah dipakai.
  res.cookies.set(PREAUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}
