import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { hybridSearch } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { getKnowledgeDeps } from "@/lib/knowledge-server";

export const dynamic = "force-dynamic";

/**
 * POST /api/knowledge/search — panel "Tes Pencarian".
 * Body: {query, topK?}. Mengembalikan chunk + skor RRF + sumber
 * (vector/fts/both) dari hybridSearch asli.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { query?: string; topK?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const query = (body.query ?? "").trim();
  if (!query) {
    return NextResponse.json({ error: "Query tidak boleh kosong." }, { status: 400 });
  }
  if (query.length > 500) {
    return NextResponse.json({ error: "Query maksimal 500 karakter." }, { status: 400 });
  }
  const topK = Math.min(Math.max(Number(body.topK) || 6, 1), 20);

  try {
    const hits = await hybridSearch(query, getKnowledgeDeps(), { topK });
    return NextResponse.json({
      results: hits.map((h) => ({
        chunkId: h.chunkId,
        itemId: h.itemId,
        chunkIndex: h.chunkIndex,
        itemTitle: h.itemTitle,
        section: h.section,
        excerpt: h.content.slice(0, 400),
        score: Math.round(h.score * 10000) / 10000,
        source: h.source,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /belum dikonfigurasi|nonaktif/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
