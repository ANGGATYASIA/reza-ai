import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import {
  SETUP_COOKIE,
  generateTotpSecret,
  getSetupAdminId,
  stashSetupTotpSecret,
  totpAuthUrl,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/setup/totp-enroll — langkah 2 wizard: buat secret TOTP,
 * kembalikan QR (data URL) + secret manual + otpauth URL.
 * Secret disimpan SEMENTARA di Redis; baru ditulis terenkripsi ke DB
 * setelah kode verifikasi benar (langkah 3).
 */
export async function GET(req: NextRequest) {
  const redis = getRedis();
  const setupToken = req.cookies.get(SETUP_COOKIE)?.value;
  const adminId = await getSetupAdminId(redis, setupToken ?? "");
  if (!adminId) {
    return NextResponse.json(
      { error: "Sesi penyiapan kedaluwarsa. Ulangi dari awal." },
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
  await stashSetupTotpSecret(redis, setupToken ?? "", secret);

  const otpauthUrl = totpAuthUrl(admin.email, secret);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 280 });

  return NextResponse.json({ secret, otpauthUrl, qrDataUrl });
}
