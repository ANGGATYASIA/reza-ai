import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import {
  hybridSearch,
  type HybridSearchHit,
  type KnowledgeDeps,
} from "./knowledge.js";
import type { EffectiveProviderConfig } from "./providers.js";

// ============================================================
// Reza AI — AI reply engine (Task 7).
//
// Alur generateReply():
//   (1) hybridSearch atas pesan lead (retrieval asli, Task 6)
//   (2) GERBANG SUFFICIENCY tanpa LLM:
//       - intent sensitif (pola keyword) -> handoff langsung
//       - 0 chunk -> handoff "di luar knowledge"
//   (3) config chat -> POST {baseUrl}/chat/completions (temperature 0.2,
//       minta JSON saja)
//   (4) validasi Zod -> objek balasan
//   (5) fallback: JSON rusak -> handoff, TIDAK PERNAH melempar
//
// Persona "Reza": profesional santai intensitas RENDAH (lihat
// ~/workspace/skills/slang-id/SKILL.md) — sapaan saya-kamu, partikel
// sih/kok sesekali, TANPA emoji, tidak pernah mengaku AI.
// ============================================================

export interface PersonaSpec {
  name: string;
  /** Gaya bahasa dari Pengaturan umum (default: "profesional-santai"). */
  tone: "santai" | "profesional-santai" | "formal";
}

export interface HistoryMessage {
  role: "lead" | "reza";
  text: string;
}

/** Riwayat yang ditempel ke prompt: N=10 pesan terakhir. */
export const PROMPT_HISTORY_LIMIT = 10;
/** Temperature rendah: balasan grounded, minim kreativitas liar. */
export const REPLY_TEMPERATURE = 0.2;
export const CHAT_TIMEOUT_MS = 60_000;

// ---------------- Intent sensitif (gerbang tanpa LLM) ----------------

export type SensitiveIntent = "negosiasi" | "survei" | "komplain" | "legal";

export interface SensitiveIntentDef {
  intent: SensitiveIntent;
  /** Pola keyword Bahasa Indonesia (case-insensitive). */
  pattern: RegExp;
  reason: string;
}

/**
 * Pola-pola intent sensitif — SELALU handoff ke Reza, tanpa LLM:
 * - negosiasi: diskon|nego|potongan harga|kurang.*harga|best price (+ varian)
 * - survei:    survei|survey|lihat (lokasi|unit)|jadwal kunjung (+ site visit)
 * - legal:     somasi|pengacara|hukum|polisi (dicek SEBELUM komplain supaya
 *              "lapor polisi" jadi legal, bukan komplain)
 * - komplain:  komplain|kecewa|tipu|menipu|lapor
 */
export const SENSITIVE_INTENTS: SensitiveIntentDef[] = [
  {
    intent: "negosiasi",
    pattern: /\bdiskon\b|nego|potongan\s+harga|kurang(in)?\s+harga|best\s+price|turun(in)?\s+harga/i,
    reason: "Negosiasi harga/diskon — perlu persetujuan Reza langsung",
  },
  {
    intent: "survei",
    pattern: /\bsurvei\b|survey|lihat\s+(lokasi|unit)|jadwal\s+kunjung|site\s*visit/i,
    reason: "Penjadwalan survei lokasi — perlu konfirmasi jadwal Reza",
  },
  {
    intent: "legal",
    pattern: /somasi|pengacara|hukum|polisi/i,
    reason: "Isu hukum — diteruskan ke Reza",
  },
  {
    intent: "komplain",
    pattern: /komplain|kecewa|tipu|menipu|ditipu|lapor/i,
    reason: "Komplain pelanggan — ditangani Reza langsung",
  },
];

/**
 * Deteksi intent sensitif dari teks pesan. Murni (tanpa I/O) — mudah
 * di-unit-test per intent. Mengembalikan definisi intent pertama yang
 * cocok, atau null bila tidak ada.
 */
export function detectSensitiveIntent(text: string): SensitiveIntentDef | null {
  for (const def of SENSITIVE_INTENTS) {
    if (def.pattern.test(text)) return def;
  }
  return null;
}

// ---------------- Prompt ----------------

export interface ReplyPromptInput {
  persona: PersonaSpec;
  history: HistoryMessage[];
  chunks: HybridSearchHit[];
}

export interface ReplyPrompt {
  /** Satu system message: identitas + gaya + guardrail + konteks + riwayat. */
  system: string;
}

function toneLine(tone: PersonaSpec["tone"]): string {
  switch (tone) {
    case "santai":
      return "Gaya santai: kalimat pendek natural, boleh partikel ringan (sih, kok) dan kata gaul ringan, tetap sopan.";
    case "formal":
      return "Gaya formal: bahasa baku yang rapi, tanpa partikel gaul dan tanpa slang.";
    case "profesional-santai":
    default:
      return "Gaya profesional santai: kalimat pendek natural, partikel sih/kok hanya sesekali, tanpa slang berat.";
  }
}

/**
 * Bangun system prompt balasan.
 * (a) identitas: {name}, marketing Grand Duta City South of Jakarta;
 * (b) kunci suara eksplisit (slang-id intensitas rendah);
 * (c) guardrail: tidak menjanjikan diskon/harga final/jadwal pasti,
 *     tidak mengaku AI, hanya fakta dari konteks (sitasi internal [n]);
 * (d) riwayat 10 pesan terakhir ("Lead: …" / "Reza: …");
 * (e) chunk bernomor [1..k] dari `content` (sudah berprefix Judul/Bagian)
 *     + judul item sumber.
 */
export function buildReplyPrompt(input: ReplyPromptInput): ReplyPrompt {
  const { persona, chunks } = input;
  const name = persona.name.trim() || "Reza";
  const history = input.history.slice(-PROMPT_HISTORY_LIMIT);

  const historyText =
    history.length > 0
      ? history
          .map(
            (m) =>
              `${m.role === "lead" ? "Lead" : name}: ${m.text.trim()}`,
          )
          .join("\n")
      : "(belum ada riwayat — ini pesan pertama)";

  const contextText = chunks
    .map(
      (c, i) =>
        `[${i + 1}] (Sumber: ${c.itemTitle})\n${c.content.trim()}`,
    )
    .join("\n\n");

  const system = `Kamu adalah ${name}, marketing Grand Duta City South of Jakarta (Parung, Bogor). Kamu membalas chat WhatsApp calon pembeli properti.

ATURAN GAYA (wajib dipatuhi):
- Sapa lead dengan "kamu". Jangan pernah memakai "Anda" atau "Saudara".
- ${toneLine(persona.tone)}
- Partikel sih/kok boleh SEKALI-SEKALI saja, jangan di tiap kalimat.
- TANPA EMOJI sama sekali. Tidak satu pun.
- Jangan pernah mengaku sebagai AI, asisten virtual, chatbot, atau program komputer. Kamu adalah ${name}, marketing Grand Duta City. Kalau ditanya siapa kamu, jawab natural sebagai ${name}.
- Jangan memakai kata/frasa: hiruk pikuk, krusial, "bukan hanya X tetapi juga Y".
- Jangan memakai em dash (—). Pakai koma atau titik saja.
- Hindari pembuka klise ("Di era digital yang serba cepat…") dan penutup ritual ("Semoga informasi ini bermanfaat").
- Spesifik di kalimat pertama: langsung jawab pertanyaannya. Satu ide, satu kalimat pendek. Natural seperti chat manusia, bukan teks brosur.

GUARDRAIL (lebih penting dari gaya):
- JANGAN PERNAH menjanjikan diskon, potongan harga, harga final, atau jadwal survei yang pasti. Info promo hanya yang tertulis di konteks.
- HANYA pakai fakta dari KONTEKS PENGETAHUAN di bawah. Setiap fakta yang kamu sebut harus ada di konteks — tandai tiap fakta dengan sitasi internal [1], [2], dst sesuai nomor konteks. Sitasi ini internal, JANGAN ditulis di balasan WhatsApp.
- Kalau pertanyaannya tidak bisa dijawab dari konteks: katakan kamu belum punya infonya dan arahkan lead untuk bertanya langsung ke ${name}. JANGAN mengarang jawaban.
- Balasan pendek, maksimal 3 kalimat, gaya chat WhatsApp. Kalau info di konteks panjang, ringkas ke intinya saja.

KONTEKS PENGETAHUAN (satu-satunya sumber fakta — jangan pakai pengetahuan lain):
${contextText}

RIWAYAT CHAT (${history.length} pesan terakhir):
${historyText}

Tugasmu: balas pesan terakhir lead. Keluarkan HANYA JSON valid, tanpa teks lain:
{"reply": "teks balasan WhatsApp", "confidence": 0.9, "handoff": false, "reason": null, "sourcesUsed": [1]}
- "reply": teks balasan WhatsApp (tanpa sitasi [n], tanpa emoji).
- "confidence": 0 sampai 1 — keyakinanmu bahwa balasan benar dan cukup dari konteks.
- "handoff": true bila pertanyaan sebaiknya ditangani manusia (di luar konteks, sensitif, atau butuh janji pasti); false bila bisa kamu jawab.
- "reason": alasan handoff dalam Bahasa Indonesia, atau null bila handoff=false.
- "sourcesUsed": nomor konteks yang faktanya kamu pakai ([] bila tidak ada).`;

  return { system };
}

// ---------------- Output LLM ----------------

const LlmReplySchema = z.object({
  reply: z.string().min(1),
  confidence: z.number().min(0).max(1),
  handoff: z.boolean(),
  reason: z.string().nullable(),
  sourcesUsed: z.array(z.number().int()),
});

export type LlmReply = z.infer<typeof LlmReplySchema>;

/** Ambil substring JSON {…} pertama dari teks (model kadang menambah prolog). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

/** Parse + validasi Zod output LLM. null bila gagal total. */
export function parseLlmReply(text: string): LlmReply | null {
  const candidate = extractJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    const res = LlmReplySchema.safeParse(parsed);
    return res.success ? res.data : null;
  } catch {
    return null;
  }
}

// ---------------- generateReply ----------------

export interface GenerateReplyInput {
  /** Pesan terbaru dari lead. */
  message: string;
  /** Riwayat percakapan (lead + balasan Reza sebelumnya). */
  history: HistoryMessage[];
  persona?: PersonaSpec;
  topK?: number;
}

export interface AiEngineDeps {
  prisma: PrismaClient;
  redis: Redis;
  getChatConfig: () => Promise<EffectiveProviderConfig | null>;
  getEmbeddingConfig: () => Promise<EffectiveProviderConfig | null>;
  /** fetch untuk embedding + chat (default: global fetch; mock di test). */
  fetchImpl?: typeof fetch;
}

export interface ReplySource {
  /** Nomor sitasi 1-based, sejajar dengan [n] di prompt. */
  index: number;
  itemTitle: string;
}

export interface GenerateReplyResult {
  reply: string;
  confidence: number;
  handoff: boolean;
  reason: string | null;
  /** Nomor chunk (1-based) yang dikutip. */
  sourcesUsed: number[];
  /** Judul sumber untuk ditampilkan di UI. */
  sources: ReplySource[];
}

function handoffResult(
  reason: string,
  hits: HybridSearchHit[],
  reply = "",
): GenerateReplyResult {
  return {
    reply,
    confidence: 0,
    handoff: true,
    reason,
    sourcesUsed: [],
    sources: [],
  };
}

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

/**
 * Hasilkan balasan Reza untuk satu pesan lead.
 * TIDAK PERNAH melempar: setiap kegagalan menjadi handoff yang valid.
 */
export async function generateReply(
  input: GenerateReplyInput,
  deps: AiEngineDeps,
): Promise<GenerateReplyResult> {
  const persona: PersonaSpec = input.persona ?? {
    name: "Reza",
    tone: "profesional-santai",
  };
  const topK = input.topK ?? 6;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const message = input.message.trim();
    if (!message) {
      return handoffResult("Pesan kosong — tidak ada yang perlu dibalas", []);
    }

    // (1) Retrieval asli.
    const knowledgeDeps: KnowledgeDeps = {
      prisma: deps.prisma,
      redis: deps.redis,
      getEmbeddingConfig: deps.getEmbeddingConfig,
      fetchImpl,
    };
    const hits = await hybridSearch(message, knowledgeDeps, {
      topK,
      fetchImpl,
    });

    // (2) Gerbang sufficiency — tanpa LLM.
    const sensitive = detectSensitiveIntent(message);
    if (sensitive) return handoffResult(sensitive.reason, hits);
    if (hits.length === 0) {
      return handoffResult("Pertanyaan di luar knowledge yang tersedia", hits);
    }

    // (3) Config chat.
    const chatCfg = await deps.getChatConfig();
    if (!chatCfg || !chatCfg.enabled) {
      return handoffResult(
        "Slot chat belum dikonfigurasi — pertanyaan diteruskan ke Reza",
        hits,
      );
    }
    const base = (chatCfg.baseUrl ?? "").replace(/\/+$/, "");
    if (!base || !chatCfg.model) {
      return handoffResult(
        "Slot chat belum lengkap (base URL/model) — pertanyaan diteruskan ke Reza",
        hits,
      );
    }

    // (4) Panggil chat completions (temperature rendah, minta JSON saja).
    const { system } = buildReplyPrompt({
      persona,
      history: input.history.slice(-PROMPT_HISTORY_LIMIT),
      chunks: hits,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${chatCfg.apiKey}`,
        },
        body: JSON.stringify({
          model: chatCfg.model,
          temperature: REPLY_TEMPERATURE,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: message },
          ],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(
        (err as Error)?.name === "AbortError"
          ? `Timeout ${CHAT_TIMEOUT_MS / 1000} detik menunggu model chat.`
          : `Gagal menghubungi model chat: ${(err as Error)?.message ?? err}`,
      );
    }
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`Model chat menjawab HTTP ${res.status}.`);
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Model chat mengembalikan konten kosong.");
    }

    // (5) Validasi Zod; gagal -> handoff, bukan throw.
    const parsed = parseLlmReply(content);
    if (!parsed) {
      return handoffResult(
        "Respon AI tidak valid, diteruskan ke Reza",
        hits,
      );
    }
    const validIdx = [...new Set(parsed.sourcesUsed)]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= hits.length)
      .sort((a, b) => a - b);
    return {
      reply: parsed.reply,
      confidence: clamp01(parsed.confidence),
      handoff: parsed.handoff,
      reason: parsed.reason,
      sourcesUsed: validIdx,
      sources: validIdx.map((n) => ({
        index: n,
        itemTitle: hits[n - 1].itemTitle,
      })),
    };
  } catch (err) {
    // Jaring pengaman terakhir: jangan pernah melempar ke pemanggil.
    const message = err instanceof Error ? err.message : String(err);
    return handoffResult(`Gagal memproses balasan: ${message}`, []);
  }
}
