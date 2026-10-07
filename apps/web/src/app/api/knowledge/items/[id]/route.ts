import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

function notFound(): NextResponse {
  return NextResponse.json({ error: "Sumber tidak ditemukan." }, { status: 404 });
}

/**
 * GET /api/knowledge/items/[id] — detail item + daftar chunk.
 * Berkas PDF mentah tidak dikembalikan (berat); teks mentah diringkas.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const item = await prisma.knowledgeItem.findUnique({
    where: { id },
    include: {
      chunks: {
        orderBy: { chunkIndex: "asc" },
        select: { id: true, chunkIndex: true, title: true, section: true, content: true },
      },
    },
  });
  if (!item) return notFound();

  return NextResponse.json({
    item: {
      id: item.id,
      title: item.title,
      type: item.type,
      status: item.status,
      category: item.category,
      validUntil: item.validUntil?.toISOString() ?? null,
      sourceUri: item.sourceUri,
      errorMessage: item.errorMessage,
      contentPreview:
        item.type === "text" && item.content
          ? item.content.slice(0, 500)
          : null,
      createdAt: item.createdAt.toISOString(),
      chunks: item.chunks.map((c) => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        title: c.title,
        section: c.section,
        excerpt: c.content.slice(0, 400),
      })),
    },
  });
}

/**
 * DELETE /api/knowledge/items/[id] — hapus item + seluruh chunk-nya
 * (cascade di database).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const item = await prisma.knowledgeItem.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!item) return notFound();

  await prisma.knowledgeItem.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
