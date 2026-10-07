import { Prisma, type PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { isMockRedis, QUEUE_PREFIX } from "./redis.js";
import { INGEST_FALLBACK_KEY } from "./ingest.js";
import {
  getSettingDecrypted,
  setSettingEncrypted,
  type EffectiveProviderConfig,
} from "./providers.js";

/**
 * Knowledge base + hybrid retrieval (Task 6).
 *
 * Alur: KnowledgeItem (sumber: teks/URL/PDF) -> extract -> chunk ->
 * embed (provider OpenAI-compatible) -> KnowledgeChunk (vector + tsv).
 * Pencarian: hybrid vector (HNSW, cosine) + full-text (GIN, tsvector),
 * digabung dengan Reciprocal Rank Fusion.
 *
 * Fungsi di sini murni terhadap dependensinya (prisma, redis, config):
 * dipakai worker produksi (apps/worker), harness E2E, dan unit test.
 */

// ============================================================
// Chunking
// ============================================================

/**
 * Estimasi token berbasis karakter: 1 token ≈ 4 karakter.
 * Rasio konservatif untuk teks Indonesia/Inggris campuran (rata-rata
 * aktual ~3,5–4,5 char/token untuk model embedding umum). Dipakai
 * agar chunking tidak butuh tokenizer native yang berat.
 */
export const CHARS_PER_TOKEN = 4;
/** Target ukuran chunk: ~512 token. */
export const CHUNK_TARGET_TOKENS = 512;
/** Overlap antar chunk berurutan: ~64 token (batas kalimat). */
export const CHUNK_OVERLAP_TOKENS = 64;

const CHUNK_TARGET_CHARS = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN; // 2048
const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN; // 256

export interface TextChunk {
  title: string;
  section: string;
  /** Sudah diawali prefix kontekstual "Judul: ...\nBagian: ...\n\n". */
  content: string;
}

/** Pecah teks menjadi kalimat (batas akhir kalimat atau baris baru). */
function splitSentences(text: string): string[] {
  const norm = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();
  if (!norm) return [];
  return norm
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Potong kalimat raksasa (> target) per kata — tanpa overlap. */
function splitLongSentence(sentence: string): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > CHUNK_TARGET_CHARS && cur) {
      parts.push(cur.trim());
      cur = "";
    }
    cur = (cur + " " + w).trim();
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.length ? parts : [sentence];
}

/**
 * Pecah teks menjadi chunk ~512 token dengan overlap ~64 token.
 * Tiap chunk diawali prefix kontekstual ringan:
 *   "Judul: <title>\nBagian: <section>\n\n"
 * (baris Bagian dilewati bila section kosong). Overlap selalu berhenti
 * di batas kalimat supaya konteks tidak terpotong di tengah.
 */
export function chunkText(
  title: string,
  section: string,
  text: string,
): TextChunk[] {
  const cleanTitle = title.trim();
  const cleanSection = section.trim();
  const prefix = cleanSection
    ? `Judul: ${cleanTitle}\nBagian: ${cleanSection}\n\n`
    : `Judul: ${cleanTitle}\n\n`;

  const bodies: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  /** true bila buf punya kalimat baru sejak flush terakhir. */
  let fresh = false;

  const flush = () => {
    if (buf.length === 0 || !fresh) return;
    bodies.push(buf.join("\n"));
    // Overlap: pertahankan kalimat-kalimat akhir >= 64 token.
    const keep: string[] = [];
    let keepLen = 0;
    for (let i = buf.length - 1; i >= 0 && keepLen < CHUNK_OVERLAP_CHARS; i--) {
      keep.unshift(buf[i]);
      keepLen += buf[i].length + 1;
    }
    buf = keep;
    bufLen = keepLen;
    fresh = false;
  };

  for (const s of splitSentences(text)) {
    if (s.length > CHUNK_TARGET_CHARS) {
      flush();
      for (const piece of splitLongSentence(s)) bodies.push(piece);
      buf = [];
      bufLen = 0;
      fresh = false;
      continue;
    }
    if (bufLen + s.length + 1 > CHUNK_TARGET_CHARS && buf.length > 0) {
      flush();
    }
    buf.push(s);
    bufLen += s.length + 1;
    fresh = true;
  }
  flush();

  return bodies.map((b) => ({
    title: cleanTitle,
    section: cleanSection,
    content: prefix + b,
  }));
}

// ============================================================
// Pembagian section
// ============================================================

export interface TextSection {
  section: string;
  text: string;
}

/**
 * Pecah teks menjadi section berdasar heading markdown (# / ## / dst.).
 * Teks sebelum heading pertama masuk section "" (tanpa nama).
 */
export function splitSections(text: string): TextSection[] {
  const sections: TextSection[] = [];
  let curSection = "";
  let curLines: string[] = [];
  const flush = () => {
    const t = curLines.join("\n").trim();
    if (t) sections.push({ section: curSection, text: t });
    curLines = [];
  };
  for (const line of text.split("\n")) {
    const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      curSection = m[2].trim();
      continue;
    }
    curLines.push(line);
  }
  flush();
  return sections.length ? sections : [{ section: "", text: text.trim() }];
}

// ============================================================
// Ekstraktor sumber
// ============================================================

export interface ExtractedSource {
  title: string;
  sections: TextSection[];
}

export type KnowledgeTypeName = "text" | "url" | "pdf";

const URL_FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000;

/** text: sumber langsung, tanpa fetch. */
export function extractTextSource(title: string, text: string): ExtractedSource {
  const t = text.trim();
  if (!t) throw new Error("Konten teks kosong.");
  return { title: title.trim(), sections: splitSections(t) };
}

/**
 * url: fetch HTML -> Readability (@mozilla/readability + linkedom).
 * Timeout 15 dtk; bukan HTML / tanpa teks / error jaringan -> throw
 * (pemanggil menandai item failed dengan pesannya).
 */
export async function extractUrlSource(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExtractedSource> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL tidak valid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL harus diawali http:// atau https://.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: { "User-Agent": "RezaAI-KnowledgeBot/1.0" },
      });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new Error(
          `Timeout ${URL_FETCH_TIMEOUT_MS / 1000} detik saat mengambil URL.`,
        );
      }
      throw new Error(`Gagal mengambil URL: ${(err as Error)?.message ?? err}`);
    }
    if (!res.ok) throw new Error(`Server menjawab HTTP ${res.status}.`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw new Error(
        `Tipe konten bukan HTML (${contentType || "tak diketahui"}).`,
      );
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_HTML_BYTES) {
      throw new Error("Halaman terlalu besar (>2MB) — tidak diproses.");
    }
    const { parseHTML } = await import("linkedom");
    const { Readability } = await import("@mozilla/readability");
    const { document } = parseHTML(bytes.toString("utf8"));
    const article = new Readability(document).parse();
    const text = (article?.textContent ?? "")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) {
      throw new Error("Tidak ada teks artikel yang bisa diekstrak dari halaman ini.");
    }
    return {
      title: article?.title?.trim() || url,
      sections: splitSections(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** pdf: ekstrak teks via unpdf (murni JS, tanpa native dependency). */
export async function extractPdfSource(
  data: Uint8Array,
  fallbackTitle: string,
): Promise<ExtractedSource> {
  let text: string;
  try {
    const { extractText } = await import("unpdf");
    const out = (await extractText(data, { mergePages: true })) as
      | { text?: string }
      | string;
    text = typeof out === "string" ? out : (out.text ?? "");
  } catch (err) {
    throw new Error(`Gagal membaca PDF: ${(err as Error)?.message ?? err}`);
  }
  text = text.replace(/[ \t\u00a0]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("PDF tidak mengandung teks yang bisa diekstrak.");
  return { title: fallbackTitle.trim(), sections: splitSections(text) };
}

// ============================================================
// Embedding (OpenAI-compatible)
// ============================================================

/** Jumlah teks per request embeddings (hemat roundtrip). */
export const EMBED_BATCH_SIZE = 32;

export interface EmbedOpts {
  batchSize?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Panggil POST {baseUrl}/embeddings {model, input: [...]}.
 * Mengembalikan array vektor sejajar dengan input. Urutan respons
 * diurutkan berdasar field `index` (tidak mengandalkan urutan server).
 */
export async function embedBatch(
  texts: string[],
  cfg: EffectiveProviderConfig,
  opts: EmbedOpts = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const base = (cfg.baseUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("baseUrl slot embedding kosong.");
  if (!cfg.model) throw new Error("Model slot embedding belum diisi.");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const batchSize = opts.batchSize ?? EMBED_BATCH_SIZE;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        throw new Error(`Timeout ${timeoutMs / 1000} detik saat meminta embedding.`);
      }
      throw new Error(`Gagal meminta embedding: ${(err as Error)?.message ?? err}`);
    }
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Embedding gagal (HTTP ${res.status}): ${body.slice(0, 200)}`,
      );
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const rows = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== batch.length) {
      throw new Error(
        `Embedding: ${rows.length} vektor untuk ${batch.length} teks — respons tidak lengkap.`,
      );
    }
    for (const r of rows) {
      if (!Array.isArray(r.embedding) || r.embedding.length === 0) {
        throw new Error("Embedding: provider mengembalikan vektor kosong.");
      }
      out.push(r.embedding);
    }
  }
  return out;
}

/** Format vektor JS -> literal Postgres `[0.1,0.2,...]`. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? String(n) : "0")).join(",")}]`;
}

// ============================================================
// Ingest: extract -> chunk -> embed -> simpan
// ============================================================

export interface KnowledgeDeps {
  prisma: PrismaClient;
  redis: Redis;
  getEmbeddingConfig: () => Promise<EffectiveProviderConfig | null>;
  /** fetch untuk ekstraktor URL & embedding (default: global fetch). */
  fetchImpl?: typeof fetch;
}

interface ItemSource {
  type: string;
  title: string;
  content: string | null;
  sourceUri: string | null;
  /** base64 berkas mentah (type=pdf). */
  dataBase64: string | null;
}

async function extractItem(
  item: ItemSource,
  deps: KnowledgeDeps,
): Promise<ExtractedSource> {
  switch (item.type) {
    case "text":
      return extractTextSource(item.title, item.content ?? "");
    case "url":
      return extractUrlSource((item.sourceUri ?? "").trim(), deps.fetchImpl);
    case "pdf":
      if (!item.dataBase64) throw new Error("Berkas PDF tidak tersimpan.");
      return extractPdfSource(
        new Uint8Array(Buffer.from(item.dataBase64, "base64")),
        item.title,
      );
    default:
      throw new Error(`Tipe sumber "${item.type}" belum didukung.`);
  }
}

export interface IngestKnowledgeResult {
  chunks: number;
}

/**
 * Ingest satu KnowledgeItem sampai tuntas.
 * Idempoten: chunk lama selalu dihapus dulu — ingest ulang aman.
 * Gagal di tahap mana pun -> status "failed" + errorMessage, lalu throw.
 */
export async function ingestKnowledgeItem(
  itemId: string,
  deps: KnowledgeDeps,
): Promise<IngestKnowledgeResult> {
  const { prisma } = deps;
  const item = await prisma.knowledgeItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error(`KnowledgeItem ${itemId} tidak ditemukan.`);

  await prisma.knowledgeItem.update({
    where: { id: itemId },
    data: { status: "processing", errorMessage: null },
  });

  try {
    const extracted = await extractItem(
      {
        type: item.type,
        title: item.title,
        content: item.content,
        sourceUri: item.sourceUri,
        dataBase64: item.data,
      },
      deps,
    );

    const chunks: TextChunk[] = [];
    for (const s of extracted.sections) {
      for (const c of chunkText(extracted.title, s.section, s.text)) {
        chunks.push(c);
      }
    }
    if (chunks.length === 0) {
      throw new Error("Tidak ada teks yang bisa diekstrak dari sumber ini.");
    }

    const cfg = await deps.getEmbeddingConfig();
    if (!cfg) {
      throw new Error(
        "Slot embedding belum dikonfigurasi — atur di Pengaturan → Provider AI.",
      );
    }
    if (!cfg.enabled) {
      throw new Error(
        "Slot embedding nonaktif — aktifkan di Pengaturan → Provider AI.",
      );
    }

    const vectors = await embedBatch(
      chunks.map((c) => c.content),
      cfg,
      { fetchImpl: deps.fetchImpl },
    );

    // Tulis atomik: hapus chunk lama + sisipkan yang baru.
    const stmts: Array<Prisma.PrismaPromise<unknown>> = [
      prisma.$executeRaw`DELETE FROM "KnowledgeChunk" WHERE "itemId" = ${itemId}`,
    ];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      stmts.push(
        prisma.$executeRaw`
          INSERT INTO "KnowledgeChunk"
            ("id","itemId","chunkIndex","title","section","content","embedding","createdAt")
          VALUES (gen_random_uuid()::text, ${itemId}, ${i}, ${c.title},
                  ${c.section || null}, ${c.content},
                  ${vectorLiteral(vectors[i])}::vector, NOW())`,
      );
    }
    await prisma.$transaction(stmts);

    await prisma.knowledgeItem.update({
      where: { id: itemId },
      data: { status: "ready", errorMessage: null },
    });
    return { chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.knowledgeItem.update({
      where: { id: itemId },
      data: { status: "failed", errorMessage: message.slice(0, 500) },
    });
    throw err;
  }
}

// ============================================================
// Hybrid search: vector (HNSW) + full-text (GIN), gabung via RRF
// ============================================================

export interface HybridSearchHit {
  chunkId: string;
  itemId: string;
  chunkIndex: number;
  title: string;
  section: string | null;
  content: string;
  itemTitle: string;
  /** Skor RRF (reciprocal rank fusion), makin besar makin relevan. */
  score: number;
  source: "vector" | "fts" | "both";
}

export interface HybridSearchOpts {
  topK?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Reciprocal Rank Fusion (k=60): gabungkan beberapa ranking menjadi satu.
 * Tiap hit mendapat 1/(k + peringkat) per ranking tempat ia muncul;
 * skor dijumlahkan. `source` menjadi "both" bila muncul di >1 ranking.
 */
export function rrfFuse(
  rankings: HybridSearchHit[][],
  topK: number,
  k = 60,
): HybridSearchHit[] {
  const acc = new Map<
    string,
    { hit: HybridSearchHit; score: number; sources: Set<"vector" | "fts"> }
  >();
  for (const ranking of rankings) {
    ranking.forEach((hit, rank) => {
      const key = hit.chunkId;
      let e = acc.get(key);
      if (!e) {
        e = { hit, score: 0, sources: new Set() };
        acc.set(key, e);
      }
      e.score += 1 / (k + rank + 1);
      e.sources.add(hit.source === "both" ? "vector" : hit.source);
    });
  }
  return [...acc.values()]
    .map((e) => ({
      ...e.hit,
      score: e.score,
      source: (e.sources.size > 1 ? "both" : [...e.sources][0]) as
        | "vector"
        | "fts"
        | "both",
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

interface CandidateRow {
  id: string;
  itemId: string;
  chunkIndex: number;
  title: string;
  section: string | null;
  content: string;
  itemTitle: string;
}

/**
 * Pencarian hybrid atas knowledge base.
 * (a) embed query; (b) 3×topK kandidat vector (cosine, HNSW);
 * (c) 3×topK kandidat full-text ('simple' — Postgres tak punya kamus
 * Indonesia); (d) gabung via RRF k=60; (e) kembalikan top-K.
 * Item kedaluwarsa (validUntil lewat) & belum ready selalu disaring.
 */
export async function hybridSearch(
  query: string,
  deps: KnowledgeDeps,
  opts: HybridSearchOpts = {},
): Promise<HybridSearchHit[]> {
  const topK = opts.topK ?? 6;
  const q = query.trim();
  if (!q) return [];

  const cfg = await deps.getEmbeddingConfig();
  if (!cfg || !cfg.enabled) {
    throw new Error("Slot embedding belum dikonfigurasi/aktif.");
  }
  const [qvec] = await embedBatch([q], cfg, {
    fetchImpl: opts.fetchImpl ?? deps.fetchImpl,
  });
  const qlit = vectorLiteral(qvec);
  const limit = topK * 3;
  const prisma = deps.prisma;

  // (b) Kandidat vector — cosine similarity = 1 - cosine distance.
  //     ORDER BY ... LIMIT memakai index HNSW (vector_cosine_ops).
  const vecRows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT c."id", c."itemId", c."chunkIndex", c."title", c."section",
           c."content", i."title" AS "itemTitle"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeItem" i ON i."id" = c."itemId"
    WHERE i."status" = 'ready'
      AND c."embedding" IS NOT NULL
      AND (i."validUntil" IS NULL OR i."validUntil" > NOW())
    ORDER BY c."embedding" <=> ${qlit}::vector
    LIMIT ${limit}`;

  // (c) Kandidat full-text — kamus 'simple' (tanpa stemming).
  const ftsRows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT c."id", c."itemId", c."chunkIndex", c."title", c."section",
           c."content", i."title" AS "itemTitle"
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeItem" i ON i."id" = c."itemId"
    WHERE i."status" = 'ready'
      AND (i."validUntil" IS NULL OR i."validUntil" > NOW())
      AND c."tsv" @@ plainto_tsquery('simple', ${q})
    ORDER BY ts_rank(c."tsv", plainto_tsquery('simple', ${q})) DESC
    LIMIT ${limit}`;

  const toHit = (r: CandidateRow, source: "vector" | "fts"): HybridSearchHit => ({
    chunkId: r.id,
    itemId: r.itemId,
    chunkIndex: r.chunkIndex,
    title: r.title,
    section: r.section,
    content: r.content,
    itemTitle: r.itemTitle,
    score: 0,
    source,
  });

  return rrfFuse(
    [vecRows.map((r) => toHit(r, "vector")), ftsRows.map((r) => toHit(r, "fts"))],
    topK,
  );
}

// ============================================================
// Reindex: ganti dimensi embedding & embed ulang semua chunk
// ============================================================

/** Setting (terenkripsi) pencatat dimensi embedding aktif. */
export const EMBEDDING_DIM_SETTING = "knowledge.embeddingDim";
/** Dimensi default kolom vector (lihat migrasi init). */
export const DEFAULT_EMBEDDING_DIM = 1536;

export interface ReindexResult {
  dimension: number;
  chunks: number;
  /** true bila kolom vector di-ALTER ke dimensi baru. */
  altered: boolean;
}

/**
 * Embed ulang SEMUA chunk dengan config embedding saat ini.
 * Dimensi dideteksi dari satu probe embed; bila beda dengan dimensi
 * kolom, kolom di-ALTER (index HNSW dibangun ulang) dulu.
 * Dipicu dari tombol "Indeks ulang" di UI dan otomatis saat model
 * embedding berubah (hook di PUT /api/settings).
 */
export async function reindexAll(
  cfg: EffectiveProviderConfig,
  deps: KnowledgeDeps,
): Promise<ReindexResult> {
  const [probe] = await embedBatch(["reindex-dim-probe"], cfg, {
    fetchImpl: deps.fetchImpl,
  });
  const dim = probe?.length ?? 0;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error("Probe embedding tidak mengembalikan vektor yang valid.");
  }

  const recorded = await getSettingDecrypted(EMBEDDING_DIM_SETTING);
  const current = recorded ? Number.parseInt(recorded, 10) : DEFAULT_EMBEDDING_DIM;

  let altered = false;
  if (dim !== current) {
    // Nilai lama pasti berdimensi salah -> buang (USING NULL), lalu
    // embed ulang semuanya di bawah. Index HNSW dibangun ulang karena
    // terikat pada tipe kolom lama.
    await deps.prisma.$executeRaw`DROP INDEX IF EXISTS "KnowledgeChunk_embedding_hnsw_idx"`;
    await deps.prisma.$executeRaw(
      Prisma.sql`ALTER TABLE "KnowledgeChunk" ALTER COLUMN "embedding" TYPE vector(${Prisma.raw(
        String(dim),
      )}) USING NULL`,
    );
    await deps.prisma.$executeRaw`CREATE INDEX "KnowledgeChunk_embedding_hnsw_idx" ON "KnowledgeChunk" USING hnsw ("embedding" vector_cosine_ops)`;
    altered = true;
  }

  const chunks = await deps.prisma.$queryRaw<Array<{ id: string; content: string }>>`
    SELECT "id", "content" FROM "KnowledgeChunk" ORDER BY "createdAt" ASC`;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const vecs = await embedBatch(
      batch.map((c) => c.content),
      cfg,
      { fetchImpl: deps.fetchImpl, batchSize: EMBED_BATCH_SIZE },
    );
    for (let j = 0; j < batch.length; j++) {
      await deps.prisma.$executeRaw`
        UPDATE "KnowledgeChunk"
        SET "embedding" = ${vectorLiteral(vecs[j])}::vector
        WHERE "id" = ${batch[j].id}`;
    }
  }

  await setSettingEncrypted(EMBEDDING_DIM_SETTING, String(dim));
  return { dimension: dim, chunks: chunks.length, altered };
}

// ============================================================
// Antrean: ingest knowledge (reuse antrean `ingest`) + reindex
// ============================================================

/** Antrean BullMQ untuk job ingest knowledge = antrean `ingest` (Task 5). */
export const KNOWLEDGE_QUEUE = "ingest" as const;
export const KNOWLEDGE_INGEST_KIND = "knowledge-item";

export interface KnowledgeIngestPayload {
  kind: "knowledge-item";
  itemId: string;
}

export function isKnowledgeIngestPayload(x: unknown): x is KnowledgeIngestPayload {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === KNOWLEDGE_INGEST_KIND &&
    typeof (x as { itemId?: unknown }).itemId === "string"
  );
}

export interface EnqueueResult {
  transport: "bullmq" | "list";
  deduped?: boolean;
}

/**
 * Antrekan ingest satu item. Di Redis asli lewat BullMQ (jobId
 * `knowledge-<itemId>` untuk dedup); di E2E/mock lewat list fallback
 * yang sama dengan pesan WhatsApp (dibedakan via payload.kind).
 */
export async function enqueueKnowledgeIngest(
  redis: Redis,
  itemId: string,
): Promise<EnqueueResult> {
  const payload: KnowledgeIngestPayload = {
    kind: KNOWLEDGE_INGEST_KIND,
    itemId,
  };
  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(KNOWLEDGE_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add("knowledge-item", payload, {
          jobId: `knowledge-${itemId}`,
          removeOnComplete: 1000,
          removeOnFail: 500,
        });
      } finally {
        await queue.close();
      }
      return { transport: "bullmq" };
    } catch (err) {
      const text = (err as Error)?.message ?? "";
      if (/already exists|duplicate/i.test(text)) {
        return { transport: "bullmq", deduped: true };
      }
      console.warn(
        "[reza-ai/core] enqueueKnowledgeIngest via BullMQ gagal, pakai list fallback:",
        text,
      );
    }
  }
  await redis.rpush(INGEST_FALLBACK_KEY, JSON.stringify(payload));
  return { transport: "list" };
}

/** Antrean BullMQ khusus reindex (sudah didaftarkan di QUEUE_NAMES). */
export const REINDEX_QUEUE = "reindex" as const;
export const REINDEX_FALLBACK_KEY = "reza:reindex:fallback";

export async function enqueueReindex(redis: Redis): Promise<EnqueueResult> {
  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(REINDEX_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add(
          "reindex-embeddings",
          { at: new Date().toISOString() },
          {
            jobId: "reindex-embeddings",
            removeOnComplete: 100,
            removeOnFail: 100,
          },
        );
      } finally {
        await queue.close();
      }
      return { transport: "bullmq" };
    } catch (err) {
      const text = (err as Error)?.message ?? "";
      if (/already exists|duplicate/i.test(text)) {
        return { transport: "bullmq", deduped: true };
      }
      console.warn(
        "[reza-ai/core] enqueueReindex via BullMQ gagal, pakai list fallback:",
        text,
      );
    }
  }
  await redis.rpush(REINDEX_FALLBACK_KEY, JSON.stringify({ kind: "reindex" }));
  return { transport: "list" };
}

/** Kuras antrean reindex fallback (dipakai worker + harness E2E). */
export async function drainReindexFallback(redis: Redis): Promise<unknown[]> {
  const out: unknown[] = [];
  for (;;) {
    const raw = await redis.lpop(REINDEX_FALLBACK_KEY);
    if (!raw) break;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}

/**
 * Poller fallback untuk antrean reindex. Config embedding di-resolve
 * saat job diproses (bukan saat enqueue) supaya selalu yang terbaru.
 */
export function startReindexFallbackPoller(
  redis: Redis,
  deps: KnowledgeDeps,
  intervalMs = 5000,
): () => void {
  const timer = setInterval(() => {
    drainReindexFallback(redis)
      .then(async (jobs) => {
        for (let n = 0; n < jobs.length; n++) {
          try {
            const cfg = await deps.getEmbeddingConfig();
            if (!cfg || !cfg.enabled) {
              throw new Error("Slot embedding belum dikonfigurasi/aktif.");
            }
            const res = await reindexAll(cfg, deps);
            console.log(
              `[reindex] selesai: ${res.chunks} chunk, dimensi ${res.dimension}` +
                (res.altered ? " (kolom di-ALTER)" : ""),
            );
          } catch (e) {
            console.error("[reindex] gagal:", (e as Error).message);
          }
        }
      })
      .catch((e) =>
        console.error("[reindex] drain fallback gagal:", (e as Error).message),
      );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Hook untuk PUT /api/settings: bila model embedding berubah,
 * antrekan job reindex. Mengembalikan true bila job di-enqueue.
 */
export async function maybeEnqueueReindex(
  redis: Redis,
  oldModel: string | null | undefined,
  newModel: string | null | undefined,
): Promise<boolean> {
  if ((oldModel ?? "") === (newModel ?? "")) return false;
  await enqueueReindex(redis);
  return true;
}

/** Dimensi embedding aktif yang tercatat (untuk UI). */
export async function getActiveEmbeddingDim(): Promise<number> {
  const recorded = await getSettingDecrypted(EMBEDDING_DIM_SETTING);
  const n = recorded ? Number.parseInt(recorded, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EMBEDDING_DIM;
}
