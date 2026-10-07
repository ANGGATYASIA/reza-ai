import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { enqueueReindex, getActiveEmbeddingDim } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/** GET /api/knowledge/reindex — status dimensi & jumlah chunk saat ini. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const [dimension, chunks, items] = await Promise.all([
    getActiveEmbeddingDim(),
    prisma.knowledgeChunk.count(),
    prisma.knowledgeItem.count(),
  ]);
  return NextResponse.json({ dimension, chunks, items });
}

/**
 * POST /api/knowledge/reindex — antrekan job reindex (embed ulang
 * seluruh chunk; ganti dimensi kolom bila model berubah).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  try {
    await enqueueReindex(getRedis());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Gagal mengantrekan reindex: ${message}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
