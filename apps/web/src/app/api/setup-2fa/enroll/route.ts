import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import {
  PREAUTH_COOKIE,
  generateTotpSecret,
  getPreAuthAdminId,
  stashReenrollTotpSecret,
  totpAuthUrl,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup-2fa/enroll — untuk admin yang lolos kata sandi tetapi
 * belum punya TOTP (mis. setelah reset via script darurat). Dijaga
 * cookie pra-autentikasi, bukan sesi penuh.
 */
export async function GET(req: NextRequest) {
  const redis = getRedis();
  const preAuthToken = req.cookies.get(PREAUTH_COOKIE)?.value;
  const adminId = await getPreAuthAdminId(redis, preAuthToken ?? "");
  if (!adminId) {
    return NextResponse.json(
      { error: "Sesi verifikasi kedaluwarsa. Masuk kembali dari awal." },
      { status: 401 },
    );
  }

  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) {
    return NextResponse.json({ error: "Akun admin tidak ditemukan." }, { status: 404 });
  }
  if (admin.totpSecret) {
    return NextResponse.json(
      { error: "Verifikasi dua langkah sudah aktif untuk akun ini." },
      { status: 409 },
    );
  }

  const secret = generateTotpSecret();
  await stashReenrollTotpSecret(redis, preAuthToken ?? "", secret);

  const otpauthUrl = totpAuthUrl(admin.email, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 280 });

  return NextResponse.json({ secret, otpauthUrl, qrDataUrl });
}
