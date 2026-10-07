import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { EffectiveProviderConfig } from "../src/providers.js";

/**
 * Unit test knowledge base (Task 6) dengan database ASLI (PGlite +
 * ekstensi vector) + Redis mock:
 * - chunker: jumlah chunk, overlap, prefix kontekstual
 * - RRF: penggabungan dua ranking buatan
 * - ekstraktor: URL (HTML/404/timeout) + PDF (unpdf)
 * - ingestKnowledgeItem -> hybridSearch (vector + FTS) + validUntil +
 *   hapus item (cascade chunk) + idempotensi
 * - reindexAll: ganti dimensi kolom vector + embed ulang
 * - maybeEnqueueReindex: hook ganti model embedding
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reza-knowledge-test-"));
process.env.DATABASE_URL = "pglite:" + "//" + dataDir;
process.env.REDIS_URL = "memory://";
process.env.MASTER_KEY = "c".repeat(64);

execFileSync("node", [join(here, "..", "scripts", "pglite-migrate.mjs")], {
  env: process.env,
  stdio: "pipe",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let core: any;
let prisma: PrismaClient;

// ---------------- Mock embedding deterministik ----------------
// Vektor hash per kata: teks yang berbagi kosakata -> cosine similarity
// tinggi. JUJUR: ini mock untuk test, bukan model embedding asli.
let mockDim = 1536;

function hashVec(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % dim] += 1;
  }
  return vec;
}

// Stub hanya memalsukan provider embedding (POST /embeddings);
// request lain (mis. ekstraksi URL) diteruskan ke fetch asli.
const realFetch = fetch;
const stubFetch = (async (
  url: string | URL | Request,
  init?: { method?: string; body?: unknown },
) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  if (!(u === "http://mock-embed.local/embeddings" && method === "POST")) {
    return realFetch(url as string, init as RequestInit);
  }
  const body = JSON.parse(String(init?.body));
  const input: string[] = body.input;
  return new Response(
    JSON.stringify({
      data: input.map((t, i) => ({ embedding: hashVec(t, mockDim), index: i })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as unknown as typeof fetch;

const mockCfg = (): EffectiveProviderConfig => ({
  slot: "embedding",
  name: "mock",
  baseUrl: "http://mock-embed.local",
  apiKey: "test-key",
  model: "mock-embed",
  enabled: true,
  inherited: false,
});

function deps(redis: Redis) {
  return {
    prisma,
    redis,
    getEmbeddingConfig: async () => mockCfg(),
    fetchImpl: stubFetch,
  };
}

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

// ---------------- PDF minimal buatan (xref dihitung) ----------------
function buildMinimalPdf(text: string): Buffer {
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ---------------- Server HTTP lokal untuk ekstraktor URL ----------------
function startHttp(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

beforeAll(async () => {
  core = await import("../src/index.js");
  prisma = core.prisma as PrismaClient;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

// ============================================================
// Chunker
// ============================================================
describe("chunkText", () => {
  it("teks pendek -> 1 chunk dengan prefix kontekstual", () => {
    const chunks = core.chunkText("Brosur GDC", "Harga", "Harga mulai Rp800 juta. Hubungi kami.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content.startsWith("Judul: Brosur GDC\nBagian: Harga\n\n")).toBe(true);
    expect(chunks[0].title).toBe("Brosur GDC");
    expect(chunks[0].section).toBe("Harga");
  });

  it("tanpa section -> prefix tanpa baris Bagian", () => {
    const chunks = core.chunkText("Judul Saja", "", "Satu kalimat.");
    expect(chunks[0].content.startsWith("Judul: Judul Saja\n\n")).toBe(true);
  });

  it("teks kosong -> tanpa chunk", () => {
    expect(core.chunkText("T", "S", "   ")).toHaveLength(0);
  });

  it("teks panjang -> banyak chunk, ada overlap antar chunk", () => {
    // 120 kalimat bernomor, masing-masing ~55 karakter -> ~6600 karakter.
    const sentences = Array.from(
      { length: 120 },
      (_, i) => `Kalimat ke-${i + 1} berisi informasi properti contoh yang cukup panjang.`,
    );
    const text = sentences.join(" ");
    const chunks = core.chunkText("Panjang", "Isi", text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const strip = (c: { content: string }) =>
      c.content.replace(/^Judul:.*\n(Bagian:.*\n)?\n/, "");
    const bodies = chunks.map(strip);
    for (const b of bodies) {
      // Tiap body <= target + slack satu kalimat panjang.
      expect(b.length).toBeLessThanOrEqual(2048 + 200);
      expect(b.length).toBeGreaterThan(0);
    }
    // Overlap: kalimat pertama chunk[i+1] muncul di akhir chunk[i].
    for (let i = 0; i < bodies.length - 1; i++) {
      const nextFirst = bodies[i + 1].split("\n")[0];
      expect(bodies[i]).toContain(nextFirst);
    }
    // Semua kalimat asli tercakup (kecuali duplikat overlap).
    const joined = bodies.join("\n");
    for (const s of sentences) expect(joined).toContain(s);
  });
});

describe("splitSections", () => {
  it("heading markdown menjadi section", () => {
    const secs = core.splitSections("# Harga\nRp800 juta.\n## Promo\nGratis AJB.");
    expect(secs.map((s: { section: string }) => s.section)).toEqual(["Harga", "Promo"]);
    expect(secs[0].text).toContain("Rp800 juta");
  });
});

// ============================================================
// RRF
// ============================================================
describe("rrfFuse", () => {
  const hit = (id: string, source: "vector" | "fts"): Record<string, unknown> => ({
    chunkId: id,
    itemId: "item1",
    chunkIndex: 0,
    title: "t",
    section: null,
    content: "c",
    itemTitle: "Item",
    score: 0,
    source,
  });

  it("menggabungkan dua ranking: yang muncul di keduanya menang", () => {
    const a = [hit("a", "vector"), hit("b", "vector"), hit("c", "vector")];
    const b = [hit("c", "fts")];
    const out = core.rrfFuse([a, b], 3);
    expect(out.map((h: { chunkId: string }) => h.chunkId)).toEqual(["c", "a", "b"]);
    expect(out[0].source).toBe("both");
    expect(out[1].source).toBe("vector");
    // Skor RRF c = 1/63 + 1/61 ; a = 1/61
    expect(out[0].score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    expect(out[1].score).toBeCloseTo(1 / 61, 10);
  });

  it("topK memotong hasil", () => {
    const a = [hit("a", "vector"), hit("b", "vector")];
    expect(core.rrfFuse([a], 1)).toHaveLength(1);
  });
});

// ============================================================
// Ekstraktor
// ============================================================
describe("extractUrlSource", () => {
  it("HTML artikel -> judul + teks", async () => {
    const srv = await startHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Promo Perumahan</title></head><body>
        <article><h1>Perumahan Contoh</h1>
        <p>Harga mulai Rp800 juta, kolam renang anak tersedia.</p></article>
      </body></html>`);
    });
    try {
      const out = await core.extractUrlSource(srv.url + "/promo");
      expect(out.title).toContain("Promo");
      const all = out.sections.map((s: { text: string }) => s.text).join(" ");
      expect(all).toContain("Rp800 juta");
    } finally {
      await srv.close();
    }
  });

  it("HTTP 404 -> throw (item akan failed)", async () => {
    const srv = await startHttp((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("not found");
    });
    try {
      await expect(core.extractUrlSource(srv.url)).rejects.toThrow(/HTTP 404/);
    } finally {
      await srv.close();
    }
  });

  it("bukan HTML -> throw", async () => {
    const srv = await startHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    try {
      await expect(core.extractUrlSource(srv.url)).rejects.toThrow(/bukan HTML/);
    } finally {
      await srv.close();
    }
  });

  it("server menggantung -> timeout 15 dtk", async () => {
    const srv = await startHttp(() => {
      /* diam: tidak pernah menjawab */
    });
    try {
      await expect(core.extractUrlSource(srv.url)).rejects.toThrow(/Timeout/);
    } finally {
      await srv.close();
    }
  }, 30000);
});

describe("extractPdfSource", () => {
  it("PDF minimal -> teks terekstrak (unpdf)", async () => {
    const pdf = buildMinimalPdf("Brosur Perumahan Contoh harga Rp900 juta");
    const out = await core.extractPdfSource(new Uint8Array(pdf), "brosur.pdf");
    expect(out.sections.map((s: { text: string }) => s.text).join(" ")).toContain(
      "Rp900 juta",
    );
  });

  it("bukan PDF -> throw", async () => {
    await expect(
      core.extractPdfSource(new Uint8Array(Buffer.from("bukan pdf")), "x.pdf"),
    ).rejects.toThrow(/Gagal membaca PDF/);
  });
});

describe("embedBatch", () => {
  it("urutan respons dipertahankan via field index", async () => {
    const texts = ["satu", "dua", "tiga"];
    const vecs = await core.embedBatch(texts, mockCfg(), { fetchImpl: stubFetch });
    expect(vecs).toHaveLength(3);
    expect(vecs[0]).toEqual(hashVec("satu", 1536));
    expect(vecs[2]).toEqual(hashVec("tiga", 1536));
  });

  it("provider error -> throw dengan status HTTP", async () => {
    const bad = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(
      core.embedBatch(["x"], mockCfg(), { fetchImpl: bad }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

// ============================================================
// Ingest + hybrid search (PGlite + vector)
// ============================================================
describe("ingest + hybridSearch", () => {
  const redis = makeRedis();

  async function addItem(data: {
    title: string;
    type: "text" | "url" | "pdf";
    content?: string;
    sourceUri?: string;
    /** base64 berkas PDF (kolom TEXT — bukan BYTEA). */
    data?: string;
    category?: string;
    validUntil?: Date;
  }) {
    return prisma.knowledgeItem.create({
      data: {
        title: data.title,
        type: data.type as "text",
        status: "processing",
        content: data.content,
        sourceUri: data.sourceUri,
        data: data.data,
        category: data.category,
        validUntil: data.validUntil,
      },
    });
  }

  it("3 item berbeda -> query mengembalikan yang paling relevan", async () => {
    const kolam = await addItem({
      title: "Fasilitas Perumahan Contoh",
      type: "text",
      content:
        "# Fasilitas\nPerumahan Contoh punya kolam renang anak dan dewasa, clubhouse, dan taman bermain. Kolam renang buka setiap hari.",
    });
    await addItem({
      title: "Harga Perumahan Contoh",
      type: "text",
      content:
        "# Harga\nHarga rumah tipe 36 mulai Rp800 juta. Skema KPR tersedia di bank rekanan.",
    });
    await addItem({
      title: "Lokasi Perumahan Contoh",
      type: "text",
      content:
        "# Lokasi\nLokasi di Parung, 10 menit ke tol. Dekat stasiun dan pasar modern.",
    });

    for (const item of await prisma.knowledgeItem.findMany()) {
      if (item.status === "processing") {
        await core.ingestKnowledgeItem(item.id, deps(redis));
      }
    }

    const check = await prisma.knowledgeItem.findUnique({ where: { id: kolam.id } });
    expect(check!.status).toBe("ready");

    const hits = await core.hybridSearch("kolam renang anak", deps(redis), { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].itemTitle).toBe("Fasilitas Perumahan Contoh");
    expect(hits[0].score).toBeGreaterThan(0);
    expect(["vector", "fts", "both"]).toContain(hits[0].source);
  });

  it("item kedaluwarsa (validUntil kemarin) TIDAK muncul di hasil", async () => {
    const kemarin = new Date(Date.now() - 24 * 3600 * 1000);
    const expired = await addItem({
      title: "Promo Kedaluwarsa",
      type: "text",
      content: "Promo spesial kolam renang gratis biaya renang seumur hidup.",
      validUntil: kemarin,
    });
    await core.ingestKnowledgeItem(expired.id, deps(redis));
    const st = await prisma.knowledgeItem.findUnique({ where: { id: expired.id } });
    expect(st!.status).toBe("ready");

    const hits = await core.hybridSearch("promo kolam renang", deps(redis), { topK: 10 });
    const titles = hits.map((h: { itemTitle: string }) => h.itemTitle);
    expect(titles).not.toContain("Promo Kedaluwarsa");
  });

  it("ingest ulang idempoten (chunk lama diganti, tidak dobel)", async () => {
    const item = await addItem({
      title: "Idempoten",
      type: "text",
      content: "Teks awal yang cukup panjang agar menjadi beberapa chunk. ".repeat(60),
    });
    const r1 = await core.ingestKnowledgeItem(item.id, deps(redis));
    const c1 = await prisma.knowledgeChunk.count({ where: { itemId: item.id } });
    expect(c1).toBe(r1.chunks);
    const r2 = await core.ingestKnowledgeItem(item.id, deps(redis));
    const c2 = await prisma.knowledgeChunk.count({ where: { itemId: item.id } });
    expect(c2).toBe(r2.chunks);
    expect(c2).toBe(c1);
  });

  it("konten kosong -> failed + errorMessage", async () => {
    const item = await addItem({ title: "Kosong", type: "text", content: "   " });
    await expect(core.ingestKnowledgeItem(item.id, deps(redis))).rejects.toThrow();
    const st = await prisma.knowledgeItem.findUnique({ where: { id: item.id } });
    expect(st!.status).toBe("failed");
    expect(st!.errorMessage).toBeTruthy();
  });

  it("URL 404 -> failed dengan pesan", async () => {
    const srv = await startHttp((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("x");
    });
    try {
      const item = await addItem({
        title: "URL Rusak",
        type: "url",
        sourceUri: srv.url + "/hilang",
      });
      await expect(core.ingestKnowledgeItem(item.id, deps(redis))).rejects.toThrow(/HTTP 404/);
      const st = await prisma.knowledgeItem.findUnique({ where: { id: item.id } });
      expect(st!.status).toBe("failed");
      expect(st!.errorMessage).toContain("404");
    } finally {
      await srv.close();
    }
  });

  it("PDF via Prisma (base64) -> ingest sampai ready", async () => {
    // Regresi: driver adapter PGlite merusak kolom Bytes biner —
    // PDF disimpan sebagai base64 TEXT.
    const pdf = buildMinimalPdf("Brosur PDF Perumahan Contoh harga Rp900 juta");
    const item = await addItem({
      title: "Brosur PDF",
      type: "pdf",
      sourceUri: "brosur.pdf",
      data: pdf.toString("base64"),
    });
    const res = await core.ingestKnowledgeItem(item.id, deps(redis));
    expect(res.chunks).toBeGreaterThan(0);
    const st = await prisma.knowledgeItem.findUnique({ where: { id: item.id } });
    expect(st!.status).toBe("ready");
    const hits = await core.hybridSearch("brosur pdf", deps(redis), { topK: 3 });
    expect(hits[0].itemTitle).toBe("Brosur PDF");
  });

  it("hapus item -> chunk ikut terhapus (cascade)", async () => {
    const item = await addItem({
      title: "Dihapus",
      type: "text",
      content: "Konten yang akan dihapus bersama chunknya.",
    });
    await core.ingestKnowledgeItem(item.id, deps(redis));
    expect(
      await prisma.knowledgeChunk.count({ where: { itemId: item.id } }),
    ).toBeGreaterThan(0);
    await prisma.knowledgeItem.delete({ where: { id: item.id } });
    expect(await prisma.knowledgeChunk.count({ where: { itemId: item.id } })).toBe(0);
  });
});

// ============================================================
// Reindex
// ============================================================
describe("reindexAll", () => {
  const redis = makeRedis();

  it("ganti dimensi 1536 -> 8: kolom di-ALTER, chunk di-embed ulang", async () => {
    // Pastikan ada chunk berdimensi 1536 dulu.
    const before = await prisma.knowledgeChunk.count();
    expect(before).toBeGreaterThan(0);

    mockDim = 8;
    const res = await core.reindexAll(mockCfg(), deps(redis));
    expect(res.altered).toBe(true);
    expect(res.dimension).toBe(8);
    expect(res.chunks).toBe(before);

    const dimRows = await prisma.$queryRaw<Array<{ t: string }>>`
      SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
      WHERE attrelid = '"KnowledgeChunk"'::regclass AND attname = 'embedding'`;
    expect(dimRows[0].t).toBe("vector(8)");
    expect(await core.getActiveEmbeddingDim()).toBe(8);

    // Pencarian tetap jalan setelah ganti dimensi.
    const hits = await core.hybridSearch("kolam renang", deps(redis), { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);

    // Dimensi sama -> tanpa ALTER.
    const res2 = await core.reindexAll(mockCfg(), deps(redis));
    expect(res2.altered).toBe(false);
    expect(res2.dimension).toBe(8);
    mockDim = 1536;
  });
});

describe("maybeEnqueueReindex", () => {
  it("model sama -> tidak enqueue", async () => {
    const redis = makeRedis();
    expect(await core.maybeEnqueueReindex(redis, "m1", "m1")).toBe(false);
    expect(await core.drainReindexFallback(redis)).toHaveLength(0);
  });

  it("model beda -> enqueue job reindex", async () => {
    const redis = makeRedis();
    expect(await core.maybeEnqueueReindex(redis, "m1", "m2")).toBe(true);
    expect(await core.drainReindexFallback(redis)).toHaveLength(1);
  });

  it("enqueueKnowledgeIngest -> payload kind benar di list", async () => {
    const redis = makeRedis();
    const { transport } = await core.enqueueKnowledgeIngest(redis, "item-abc");
    expect(transport).toBe("list");
    const raw = await redis.lpop("reza:ingest:fallback");
    expect(JSON.parse(raw as string)).toEqual({ kind: "knowledge-item", itemId: "item-abc" });
  });
});
