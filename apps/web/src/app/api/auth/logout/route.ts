import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { PREAUTH_COOKIE, SESSION_COOKIE, destroySession, sessionCookieOptions } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — hancurkan sesi di Redis, bersihkan cookie.
 * Selalu sukses (idempotent): tanpa sesi pun cookie dibersihkan.
 */
export async function POST(req: NextRequest) {
  const redis = getRedis();
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  await destroySession(redis, token ?? "");

  const res = NextResponse.json({ ok: true });
  const clear = { ...sessionCookieOptions(0), maxAge: 0 };
  res.cookies.set(SESSION_COOKIE, "", clear);
  res.cookies.set(PREAUTH_COOKIE, "", clear);
  return res;
}
