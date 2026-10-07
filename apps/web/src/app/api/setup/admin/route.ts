import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hashPassword, validateEmail, validatePasswordStrength } from "@reza-ai/core";
import {
  SETUP_COOKIE,
  SETUP_TTL_SEC,
  createSetupToken,
  sessionCookieOptions,
} from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

interface SetupAdminBody {
  email?: string;
  password?: string;
}

/**
 * POST /api/setup/admin — langkah 1 wizard: buat akun admin pertama.
 * Hanya bisa dipanggil bila tabel Admin kosong. Mengeluarkan cookie
 * sesi penyiapan (15 menit) untuk langkah TOTP berikutnya.
 */
export async function POST(req: NextRequest) {
  const count = await prisma.admin.count();
  if (count > 0) {
    return NextResponse.json(
      { error: "Penyiapan sudah selesai. Masuk dengan akun admin." },
      { status: 409 },
    );
  }

  let body: SetupAdminBody;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!validateEmail(email)) {
    return NextResponse.json({ error: "Alamat email tidak valid." }, { status: 400 });
  }
  const weak = validatePasswordStrength(password);
  if (weak) {
    return NextResponse.json({ error: weak }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);
  const admin = await prisma.admin.create({
    data: { email, passwordHash, totpSecret: null },
  });

  const redis = getRedis();
  const setupToken = await createSetupToken(redis, admin.id);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SETUP_COOKIE, setupToken, sessionCookieOptions(SETUP_TTL_SEC));
  return res;
}
