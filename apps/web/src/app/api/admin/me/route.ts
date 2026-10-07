import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/me — contoh route terproteksi.
 * Pola ini dipakai semua API admin berikutnya: requireAdmin() dulu,
 * kembalikan auth.response bila sesi tidak valid.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;
  return NextResponse.json({ id: auth.admin.id, email: auth.admin.email });
}
