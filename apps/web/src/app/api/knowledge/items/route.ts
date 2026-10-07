import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  enqueueKnowledgeIngest,
  getActiveEmbeddingDim,
  getEffectiveProviderConfig,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;

function bad(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/knowledge/items — daftar sumber pengetahuan + status.
 * embeddingConfigured=false -> UI menampilkan peringatan ke /settings.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const [items, cfg, dim] = await Promise.all([
    prisma.knowledgeItem.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { chunks: true } } },
    }),
    getEffectiveProviderConfig("embedding"),
    getActiveEmbeddingDim(),
  ]);

  return NextResponse.json({
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      type: i.type,
      status: i.status,
      category: i.category,
      validUntil: i.validUntil?.toISOString() ?? null,
      sourceUri: i.sourceUri,
      errorMessage: i.errorMessage,
      chunkCount: i._count.chunks,
      createdAt: i.createdAt.toISOString(),
    })),
    embeddingConfigured: !!(cfg && cfg.enabled),
    embeddingDim: dim,
  });
}

interface CreatePayload {
  type?: string;
  title?: string;
  content?: string;
  url?: string;
  category?: string;
  validUntil?: string;
}

/**
 * POST /api/knowledge/items — tambah sumber pengetahuan.
 * - JSON: {type:"text"|"url", title, content|url, category?, validUntil?}
 * - multipart: type=pdf + file + title (+category?, validUntil?)
 * Membuat item (status processing) lalu mengantrekan job ingest nyata.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const contentType = req.headers.get("content-type") ?? "";
  let payload: CreatePayload = {};
  let pdfBytes: Buffer | null = null;
  let pdfName = "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      payload = {
        type: "pdf",
        title: String(form.get("title") ?? ""),
        category: form.get("category") ? String(form.get("category")) : undefined,
        validUntil: form.get("validUntil")
          ? String(form.get("validUntil"))
          : undefined,
      };
      const file = form.get("file");
      if (file instanceof File) {
        pdfBytes = Buffer.from(await file.arrayBuffer());
        pdfName = file.name || "dokumen.pdf";
      }
    } else {
      payload = (await req.json()) as CreatePayload;
    }
  } catch {
    return bad("Body tidak valid.");
  }

  // ---- Validasi ----
  const type = payload.type;
  if (type !== "text" && type !== "url" && type !== "pdf") {
    return bad("Tipe harus text, url, atau pdf.");
  }
  const title = (payload.title ?? "").trim();
  if (!title) return bad("Judul wajib diisi.");
  if (title.length > 200) return bad("Judul maksimal 200 karakter.");
  const category = (payload.category ?? "").trim() || null;
  if (category && category.length > 80) return bad("Kategori maksimal 80 karakter.");

  let validUntil: Date | null = null;
  if (payload.validUntil) {
    const d = new Date(payload.validUntil);
    if (Number.isNaN(d.getTime())) return bad("Tanggal validUntil tidak valid.");
    validUntil = d;
  }

  const createData: {
    title: string;
    type: "text" | "url" | "pdf";
    status: "processing";
    category: string | null;
    validUntil: Date | null;
    content?: string;
    sourceUri?: string;
    /** base64 berkas PDF (TEXT — lihat catatan di schema.prisma). */
    data?: string;
  } = { title, type, status: "processing", category, validUntil };

  if (type === "text") {
    const content = (payload.content ?? "").trim();
    if (!content) return bad("Konten teks wajib diisi.");
    if (content.length > MAX_TEXT_CHARS)
      return bad("Konten teks maksimal 200.000 karakter.");
    createData.content = content;
  } else if (type === "url") {
    const url = (payload.url ?? "").trim();
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      return bad("URL harus diawali http:// atau https://.");
    }
    if (url.length > 2000) return bad("URL terlalu panjang.");
    createData.sourceUri = url;
  } else {
    if (!pdfBytes || pdfBytes.length === 0) return bad("Berkas PDF wajib diunggah.");
    if (pdfBytes.length > MAX_PDF_BYTES)
      return bad("Ukuran PDF maksimal 10MB.");
    if (!/\.pdf$/i.test(pdfName)) return bad("Berkas harus PDF.");
    createData.data = pdfBytes.toString("base64");
    createData.sourceUri = pdfName.slice(0, 200);
  }

  const item = await prisma.knowledgeItem.create({ data: createData });

  try {
    await enqueueKnowledgeIngest(getRedis(), item.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.knowledgeItem.update({
      where: { id: item.id },
      data: {
        status: "failed",
        errorMessage: `Gagal mengantrekan job: ${message}`.slice(0, 500),
      },
    });
    return bad(`Gagal mengantrekan job ingest: ${message}`, 500);
  }

  return NextResponse.json({ id: item.id, status: "processing" }, { status: 201 });
}
