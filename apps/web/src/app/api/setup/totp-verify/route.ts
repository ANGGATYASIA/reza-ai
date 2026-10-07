import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  SETUP_COOKIE,
  destroySetupToken,
  getSetupAdminId,
  packTotpSecret,
  takeSetupTotpSecret,
  verifyTotpToken,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

interface VerifyBody {
  code?: string;
}

/**
 * POST /api/setup/totp-verify — langkah 3 wizard: verifikasi kode 6 digit.
 * Sukses -> secret disimpan TERENKRIPSI di Admin.totpSecret, sesi
 * penyiapan dihancurkan. Klien lalu diarahkan ke /login.
 */
export async function POST(req: NextRequest) {
  const redis = getRedis();
  const setupToken = req.cookies.get(SETUP_COOKIE)?.value;
  const adminId = await getSetupAdminId(redis, setupToken ?? "");
  if (!adminId) {
    return NextResponse.json(
      { error: "Sesi penyiapan kedaluwarsa. Ulangi dari awal." },
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

  const pendingSecret = await takeSetupTotpSecret(redis, setupToken ?? "");
  if (!pendingSecret) {
    return NextResponse.json(
      { error: "Sesi penyiapan kedaluwarsa. Ulangi dari awal." },
      { status: 401 },
    );
  }

  if (!verifyTotpToken(pendingSecret, code)) {
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
      {
        error:
          "Gagal menyimpan secret 2FA. Pastikan MASTER_KEY terisi di environment server.",
      },
      { status: 500 },
    );
  }

  await destroySetupToken(redis, setupToken ?? "");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SETUP_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
