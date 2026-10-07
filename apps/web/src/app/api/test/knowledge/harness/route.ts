import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { getKnowledgeHarness, startKnowledgeHarness } from "@/lib/knowledge-harness";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * POST: nyalakan harness knowledge in-process (idempoten) — poller
 * ingest+reindex memakai fungsi produksi @reza-ai/core
 * (ingestKnowledgeItem, reindexAll) terhadap PGlite yang sama.
 * GET: status harness (jalan / belum).
 */
export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  startKnowledgeHarness();
  return NextResponse.json({ ok: true, running: true });
}

export async function GET(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  return NextResponse.json({ running: !!getKnowledgeHarness() });
}
