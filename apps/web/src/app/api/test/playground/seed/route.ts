import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ingestKnowledgeItem } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";
import { getKnowledgeDeps } from "@/lib/knowledge-server";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * POST: buat satu KnowledgeItem teks berisi HARGA FIKTIF (jelas
 * ditandai "DATA UJI") lalu ingest sinkron via ingestKnowledgeItem
 * (kode produksi — extract -> chunk -> embed -> PGlite). Dipakai
 * playground.spec.ts agar generateReply punya konteks nyata.
 *
 * JUJUR: ini data uji, bukan data Grand Duta City sungguhan. Judul
 * dan isi item selalu memuat penanda "DATA UJI (fiktif)".
 */
const SEED_TITLE = "Daftar Harga Tipe Verona — DATA UJI (fiktif)";

const SEED_TEXT = `# Daftar Harga Tipe Verona — DATA UJI (fiktif)

Tipe Verona adalah contoh tipe unit FIKTIF untuk pengujian otomatis
playground (bukan harga Grand Duta City sungguhan).
Harga mulai Rp950 juta. Luas tanah 72 m2, luas bangunan 45 m2.
`;

export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  // Hapus seed lama (idempoten bila spec dijalankan ulang).
  await prisma.knowledgeItem.deleteMany({ where: { title: SEED_TITLE } });

  const item = await prisma.knowledgeItem.create({
    data: {
      type: "text",
      title: SEED_TITLE,
      content: SEED_TEXT,
      category: "e2e-test",
      status: "processing",
    },
  });

  try {
    const res = await ingestKnowledgeItem(item.id, getKnowledgeDeps());
    return NextResponse.json({ ok: true, itemId: item.id, chunks: res.chunks });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Ingest seed gagal: ${message}` },
      { status: 500 },
    );
  }
}
