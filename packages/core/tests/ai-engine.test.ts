import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { EffectiveProviderConfig } from "../src/providers.js";

/**
 * Unit test AI reply engine (Task 7) dengan database ASLI (PGlite +
 * ekstensi vector) + Redis mock + stub fetch ganda:
 * - POST /embeddings  -> vektor hash deterministik per kata (pola Task 6)
 * - POST /chat/completions -> JSON canned sesuai `chatMode`
 *
 * Yang diuji: detectSensitiveIntent per intent, buildReplyPrompt (isi
 * persona + aturan gaya + chunk bersitasi), generateReply end-to-end
 * (retrieval asli -> gerbang handoff -> LLM stub -> validasi Zod ->
 * fallback tanpa throw).
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reza-aiengine-test-"));
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.REDIS_URL = "memory://";
process.env.MASTER_KEY = "d".repeat(64);

execFileSync("node", [join(here, "..", "scripts", "pglite-migrate.mjs")], {
  env: process.env,
  stdio: "pipe",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let core: any;
let prisma: PrismaClient;

// ---------------- Stub fetch ----------------

const EMBED_DIM = 1536;

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

/** Mode respons chat stub: "valid" | "garbage" | "emoji". */
let chatMode: "valid" | "garbage" | "emoji" = "valid";
/** Hitung berapa kali endpoint chat dipanggil (bukti gerbang tanpa LLM). */
let chatCalls = 0;

function chatPayload(): unknown {
  const base = {
    reply:
      "Harga tipe Verona mulai Rp950 juta (data uji). Mau aku infoin detail lainnya?",
    confidence: 0.9,
    handoff: false,
    reason: null,
    sourcesUsed: [1],
  };
  if (chatMode === "garbage") {
    return { choices: [{ message: { content: "maaf, server lagi error nih" } }] };
  }
  if (chatMode === "emoji") {
    return {
      choices: [
        {
          message: {
            // Sengaja melanggar (emoji + "Anda"): engine tetap meloloskan —
            // guardrail adalah instruksi prompt, penegakannya ranah LLM.
            content: JSON.stringify({
              ...base,
              reply: "Harganya Rp950 juta 😀 Anda mau survei?",
            }),
          },
        },
      ],
    };
  }
  return { choices: [{ message: { content: JSON.stringify(base) } }] };
}

const realFetch = fetch;
const stubFetch = (async (
  url: string | URL | Request,
  init?: { method?: string; body?: unknown },
) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  if (u === "http://mock-embed.local/embeddings" && method === "POST") {
    const body = JSON.parse(String(init?.body));
    const input: string[] = body.input;
    return new Response(
      JSON.stringify({
        data: input.map((t, i) => ({ embedding: hashVec(t, EMBED_DIM), index: i })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (u === "http://mock-chat.local/chat/completions" && method === "POST") {
    chatCalls++;
    return new Response(JSON.stringify(chatPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return realFetch(url as string, init as RequestInit);
}) as unknown as typeof fetch;

const embedCfg = (): EffectiveProviderConfig => ({
  slot: "embedding",
  name: "mock",
  baseUrl: "http://mock-embed.local",
  apiKey: "embed-key",
  model: "mock-embed",
  enabled: true,
  inherited: false,
});

const chatCfg = (): EffectiveProviderConfig => ({
  slot: "chat",
  name: "mock",
  baseUrl: "http://mock-chat.local",
  apiKey: "chat-key",
  model: "mock-chat",
  enabled: true,
  inherited: false,
});

function makeRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

function engineDeps(redis: Redis) {
  return {
    prisma,
    redis,
    getChatConfig: async () => chatCfg(),
    getEmbeddingConfig: async () => embedCfg(),
    fetchImpl: stubFetch,
  };
}

const SEED_TITLE = "Daftar Harga Tipe Verona — DATA UJI (fiktif)";
const SEED_TEXT = `# Daftar Harga Tipe Verona — DATA UJI (fiktif)

Tipe Verona adalah contoh tipe unit fiktif untuk pengujian otomatis.
Harga mulai Rp950 juta. Luas tanah 72 m2, luas bangunan 45 m2.
`;

async function seedVerona(redis: Redis): Promise<void> {
  const item = await prisma.knowledgeItem.create({
    data: {
      type: "text",
      title: SEED_TITLE,
      content: SEED_TEXT,
      status: "processing",
    },
  });
  await core.ingestKnowledgeItem(item.id, {
    prisma,
    redis,
    getEmbeddingConfig: async () => embedCfg(),
    fetchImpl: stubFetch,
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
// detectSensitiveIntent — murni, per intent
// ============================================================
describe("detectSensitiveIntent", () => {
  const cases: Array<[string, "negosiasi" | "survei" | "komplain" | "legal"]> = [
    ["Bisa diskon 10%?", "negosiasi"],
    ["Harganya bisa nego nggak?", "negosiasi"],
    ["Ada potongan harga buat cash keras?", "negosiasi"],
    ["Best price-nya berapa?", "negosiasi"],
    ["Bisa survei hari Sabtu?", "survei"],
    ["Mau lihat unitnya langsung", "survei"],
    ["Ada jadwal kunjung minggu ini?", "survei"],
    ["Saya kecewa dengan pelayanannya", "komplain"],
    ["Ini penipuan, saya mau lapor", "komplain"],
    ["Saya akan kirim somasi", "legal"],
    ["Pengacara saya akan hubungi", "legal"],
    ["Saya lapor polisi saja", "legal"],
  ];
  for (const [text, want] of cases) {
    it(`"${text}" -> ${want}`, () => {
      const hit = core.detectSensitiveIntent(text);
      expect(hit).not.toBeNull();
      expect(hit.intent).toBe(want);
      expect(typeof hit.reason).toBe("string");
      expect(hit.reason.length).toBeGreaterThan(0);
    });
  }
  it("pertanyaan biasa -> null", () => {
    expect(core.detectSensitiveIntent("Harga tipe Verona berapa?")).toBeNull();
    expect(core.detectSensitiveIntent("Ada kolam renang nggak?")).toBeNull();
  });
});

// ============================================================
// buildReplyPrompt — isi prompt
// ============================================================
describe("buildReplyPrompt", () => {
  it("memuat nama persona, aturan tanpa emoji, dan chunk bersitasi", () => {
    const { system } = core.buildReplyPrompt({
      persona: { name: "Reza", tone: "profesional-santai" },
      history: [
        { role: "lead", text: "Halo, info harga dong" },
        { role: "reza", text: "Halo! Mau info tipe yang mana?" },
      ],
      chunks: [
        {
          chunkId: "c1",
          itemId: "i1",
          chunkIndex: 0,
          title: SEED_TITLE,
          section: "",
          content: `Judul: ${SEED_TITLE}\n\nHarga mulai Rp950 juta.`,
          itemTitle: SEED_TITLE,
          score: 0.5,
          source: "both",
        },
      ],
    });
    expect(system).toContain("Reza");
    expect(system).toMatch(/tanpa emoji/i);
    expect(system).toContain("[1]");
    expect(system).toContain("Harga mulai Rp950 juta.");
    expect(system).toContain(`(Sumber: ${SEED_TITLE})`);
    expect(system).toContain("Lead: Halo, info harga dong");
    expect(system).toContain("Reza: Halo! Mau info tipe yang mana?");
    // Guardrail eksplisit di prompt.
    expect(system).toMatch(/jangan.*mengaku.*AI/i);
    expect(system).toMatch(/JANGAN PERNAH menjanjikan diskon/i);
  });

  it("riwayat dibatasi 10 pesan terakhir", () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? ("lead" as const) : ("reza" as const),
      text: `pesan ${i}`,
    }));
    const { system } = core.buildReplyPrompt({
      persona: { name: "Reza", tone: "profesional-santai" },
      history,
      chunks: [],
    });
    expect(system).not.toContain("pesan 0");
    expect(system).toContain("pesan 14");
  });
});

// ============================================================
// generateReply — retrieval asli + gerbang + LLM stub
// ============================================================
describe("generateReply", () => {
  it("(a) JSON valid -> objek balasan benar", async () => {
    const redis = makeRedis();
    await prisma.knowledgeItem.deleteMany({});
    await seedVerona(redis);
    chatMode = "valid";
    chatCalls = 0;

    const res = await core.generateReply(
      { message: "Harga tipe Verona berapa?", history: [] },
      engineDeps(redis),
    );
    expect(res.handoff).toBe(false);
    expect(res.reply).toContain("Rp950 juta");
    expect(res.confidence).toBe(0.9);
    expect(res.sourcesUsed).toEqual([1]);
    expect(res.sources).toHaveLength(1);
    expect(res.sources[0].itemTitle).toContain("Verona");
    expect(chatCalls).toBe(1);
  });

  it("(b) JSON rusak total -> handoff tanpa throw", async () => {
    const redis = makeRedis();
    chatMode = "garbage";

    const res = await core.generateReply(
      { message: "Harga tipe Verona berapa?", history: [] },
      engineDeps(redis),
    );
    expect(res.handoff).toBe(true);
    expect(res.reason).toBe("Respon AI tidak valid, diteruskan ke Reza");
    expect(res.reply).toBe("");
  });

  it("(c) gerbang intent sensitif -> handoff + reason tepat, tanpa panggil LLM", async () => {
    const redis = makeRedis();
    chatMode = "valid";
    chatCalls = 0;

    const cases: Array<[string, string]> = [
      ["Bisa diskon 10%?", "Negosiasi harga/diskon"],
      ["Bisa survei hari Sabtu?", "survei"],
      ["Saya kecewa dengan pelayanannya", "Komplain"],
      ["Saya akan kirim somasi", "hukum"],
    ];
    for (const [q, wantReason] of cases) {
      const res = await core.generateReply(
        { message: q, history: [] },
        engineDeps(redis),
      );
      expect(res.handoff, q).toBe(true);
      expect(res.reason, q).toContain(wantReason);
    }
    expect(chatCalls).toBe(0);

    // Tanya harga biasa -> handoff=false.
    const ok = await core.generateReply(
      { message: "Harga tipe Verona berapa?", history: [] },
      engineDeps(redis),
    );
    expect(ok.handoff).toBe(false);
  });

  it("(d) 0 chunk -> handoff 'di luar knowledge'", async () => {
    const redis = makeRedis();
    await prisma.knowledgeItem.deleteMany({});

    const res = await core.generateReply(
      { message: "Ada promo apa saja?", history: [] },
      engineDeps(redis),
    );
    expect(res.handoff).toBe(true);
    expect(res.reason).toBe("Pertanyaan di luar knowledge yang tersedia");

    await seedVerona(redis);
  });

  it("(f) balasan melanggar gaya dari LLM tetap lolos (ranah LLM, bukan engine)", async () => {
    const redis = makeRedis();
    chatMode = "emoji";

    const res = await core.generateReply(
      { message: "Harga tipe Verona berapa?", history: [] },
      engineDeps(redis),
    );
    // Guardrail "tanpa emoji / tanpa Anda" adalah instruksi di prompt;
    // engine tidak menyensor output LLM — dicatat eksplisit di sini.
    expect(res.handoff).toBe(false);
    expect(res.reply).toContain("😀");
    expect(res.reply).toContain("Anda");
  });

  it("slot chat belum dikonfigurasi -> handoff jelas, bukan throw", async () => {
    const redis = makeRedis();
    const res = await core.generateReply(
      { message: "Harga tipe Verona berapa?", history: [] },
      { ...engineDeps(redis), getChatConfig: async () => null },
    );
    expect(res.handoff).toBe(true);
    expect(res.reason).toMatch(/Slot chat belum dikonfigurasi/);
  });
});
