import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { getInboxHarness } from "@/lib/inbox-harness";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * Membaca daftar pesan yang "terkirim" lewat FakeGateway harness —
 * bukti bahwa kiriman dari UI /inbox benar-benar sampai ke gateway
 * (jalur: UI -> /api/inbox/send -> antrean send -> processSendJob ->
 * FakeGateway.send).
 */
export async function GET(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const harness = getInboxHarness();
  if (!harness) {
    return NextResponse.json(
      { error: "Harness belum jalan — POST /api/test/inbox/harness dulu." },
      { status: 400 },
    );
  }

  return NextResponse.json({
    texts: harness.gateway.sentTexts.map((s) => ({
      to: s.to,
      body: s.body,
      id: s.id,
    })),
    media: harness.gateway.sentMedia.map((s) => ({
      to: s.to,
      path: s.path,
      caption: s.caption,
      id: s.id,
    })),
  });
}
