import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { getInboxHarness, startInboxHarness } from "@/lib/inbox-harness";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * POST: nyalakan harness inbox in-process (idempoten) — FakeGateway +
 * consumer ingest/send memakai fungsi produksi @reza-ai/core.
 * GET: status harness (jalan / belum).
 */
export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const harness = startInboxHarness();
  return NextResponse.json({
    ok: true,
    running: true,
    connected: harness.gateway.connected,
  });
}

export async function GET(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const harness = getInboxHarness();
  return NextResponse.json({
    running: !!harness,
    connected: harness?.gateway.connected ?? false,
  });
}
