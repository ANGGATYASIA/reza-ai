import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PREAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  createSession,
  destroyPreAuth,
  destroyReenrollTotpSecret,
  getPreAuthAdminId,
  packTotpSecret,
  sessionCookieOptions,
  takeReenrollTotpSecret,
  verifyTotpToken,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

interface VerifyBody {
  code?: string;
}

/**
 * POST /api/setup-2fa/verify — verifikasi kode, simpan secret terenkripsi,
 * lalu langsung buat sesi penuh (kata sandi sudah terbukti di langkah 1).
 */
export async function POST(req: NextRequest) {
  const redis = getRedis();
  const preAuthToken = req.cookies.get(PREAUTH_COOKIE)?.value;
  const adminId = await getPreAuthAdminId(redis, preAuthToken ?? "");
  if (!adminId) {
    return NextResponse.json(
      { error: "Sesi verifikasi kedaluwarsa. Masuk kembali dari awal." },
      { status: 401 },
    );
  }

  let body: VerifyBody;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const code = (body.code ?? "").trim();

  const pendingSecret = await takeReenrollTotpSecret(redis, preAuthToken ?? "");
  if (!pendingSecret || !verifyTotpToken(pendingSecret, code)) {
    return NextResponse.json(
      { error: "Kode verifikasi salah. Periksa aplikasi autentikator lalu coba lagi." },
      { status: 400 },
    );
  }

  try {
    await prisma.admin.update({
      where: { id: adminId },
      data: { totpSecret: packTotpSecret(pendingSecret) },
    });
  } catch {
    return NextResponse.json(
      { error: "Gagal menyimpan secret 2FA. Pastikan MASTER_KEY terisi di environment server." },
      { status: 500 },
    );
  }

  await destroyReenrollTotpSecret(redis, preAuthToken ?? "");
  await destroyPreAuth(redis, preAuthToken ?? "");
  const sessionToken = await createSession(redis, adminId);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionToken, sessionCookieOptions(SESSION_TTL_SEC));
  res.cookies.set(PREAUTH_COOKIE, "", { ...sessionCookieOptions(0), maxAge: 0 });
  return res;
}
