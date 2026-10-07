import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { peekWaCommandFallback } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * Membaca perintah wa-command yang TERCATAT (belum dikonsumsi worker).
 * Di E2E (Redis in-memory) perintah lewat list fallback karena BullMQ
 * butuh Lua asli — endpoint ini membaca list tersebut.
 * Dipakai test untuk membuktikan klik "Logout" benar-benar mengirim perintah.
 */
export async function GET(req: NextRequest) {
  if (process.env.E2E_TEST_API !== "1") {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const commands = await peekWaCommandFallback(getRedis());
  return NextResponse.json({ ok: true, commands });
}
