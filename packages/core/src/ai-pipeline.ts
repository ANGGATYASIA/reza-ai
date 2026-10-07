import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { WhatsAppGateway } from "./gateway.js";
import {
  generateReply,
  type GenerateReplyResult,
} from "./ai-engine.js";
import { publishInboxEvent } from "./inbox-events.js";
import { enqueueSend } from "./send-queue.js";
import { isMockRedis, QUEUE_PREFIX } from "./redis.js";
import { normalizePn } from "./wa-jid.js";
import type {
  EffectiveProviderConfig,
  GeneralSettings,
} from "./providers.js";

// ============================================================
// Reza AI — pipeline AI WhatsApp (Task 8).
//
// Alur: pesan masuk (ingest) -> scheduleAiReply (debounce per chat)
// -> antrean `ai-reply` -> processAiReply (konsumen):
//    (a) lewati: chat ignored / AI dijeda / pesan terakhir dari kita
//    (b) 10 pesan terakhir -> generateReply (Task 7, tidak pernah throw)
//    (c) handoff (flag LLM / intent sensitif / confidence < threshold)
//    (d) mode full -> presence "composing" + jeda acak + enqueueSend
//    (e) mode semi -> Draft pending + notifikasi owner
//    (f) mode off -> diam
//
// Debounce self-correcting: setiap pesan baru menggeser kunci
// `reza:ai:debounce:<chatId>` (deadline). Job yang bangun lebih awal
// MENJADWALKAN ULANG dirinya dengan sisa delay — jadi bubble chat
// beruntun hanya memicu SATU eksekusi generateReply setelah window
// sepi. Lock `reza:ai:run:<chatId>` (SET NX) mencegah dua job
// mengerjakan chat yang sama bersamaan.
// ============================================================

/** Nama antrean BullMQ (sudah terdaftar di QUEUE_NAMES). */
export const AI_REPLY_QUEUE = "ai-reply" as const;

/** List fallback untuk E2E (pola Task 5: BullMQ butuh Lua asli). */
export const AI_REPLY_FALLBACK_KEY = "reza:ai-reply:fallback";

/** Riwayat yang dipakai generateReply: N=10 pesan terakhir. */
export const AI_HISTORY_LIMIT = 10;

export type AiMode = "full" | "semi" | "off";

/** Kunci deadline debounce per chat: nilainya epoch-ms. */
export const aiDebounceKey = (chatId: string): string =>
  `reza:ai:debounce:${chatId}`;

/** Lock eksekusi per chat (SET NX, EX 600 detik, dilepas di finally). */
export const aiRunLockKey = (chatId: string): string =>
  `reza:ai:run:${chatId}`;

export interface AiReplyJobPayload {
  chatId: string;
  /** Jangan proses sebelum epoch-ms ini (dipakai jadwal ulang debounce). */
  notBefore?: number;
}

// ---------------- Resolusi mode ----------------

/**
 * Mode efektif satu chat: override chat menang atas mode global.
 * Nilai asing -> "full" (aman: perilaku default sebelum Task 8).
 */
export function resolveMode(
  chat: { modeOverride?: string | null },
  general: GeneralSettings,
): AiMode {
  const raw = chat.modeOverride ?? general.aiMode;
  if (raw === "semi") return "semi";
  if (raw === "off") return "off";
  return "full";
}

// ---------------- Enqueue + debounce ----------------

/**
 * Masukkan job ai-reply ke antrean (delayMs opsional untuk debounce).
 * Di E2E (Redis mock) -> list fallback dengan notBefore.
 */
export async function enqueueAiReply(
  redis: Redis,
  chatId: string,
  delayMs = 0,
): Promise<{ transport: "bullmq" | "list" }> {
  if (!chatId) throw new Error("enqueueAiReply: chatId wajib diisi.");
  const payload: AiReplyJobPayload = {
    chatId,
    ...(delayMs > 0 ? { notBefore: Date.now() + delayMs } : {}),
  };

  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(AI_REPLY_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add("ai-reply", payload, {
          delay: delayMs,
          removeOnComplete: 1000,
          removeOnFail: 500,
        });
      } finally {
        await queue.close();
      }
      return { transport: "bullmq" };
    } catch (err) {
      console.warn(
        "[reza-ai/core] enqueueAiReply via BullMQ gagal, pakai list fallback:",
        (err as Error).message,
      );
    }
  }

  await redis.rpush(AI_REPLY_FALLBACK_KEY, JSON.stringify(payload));
  return { transport: "list" };
}

/**
 * Dipanggil ingest setelah menyimpan pesan masuk (non-ignored,
 * bukan fromMe): geser deadline debounce + antrekan job ai-reply.
 * debounceSec bisa 0 (langsung) — dipakai E2E.
 */
export async function scheduleAiReply(
  redis: Redis,
  chatId: string,
  debounceSec: number,
): Promise<void> {
  const delayMs = Math.max(0, Math.round(debounceSec * 1000));
  const until = Date.now() + delayMs;
  await redis.set(aiDebounceKey(chatId), String(until), "EX", delayMs / 1000 + 120);
  await enqueueAiReply(redis, chatId, delayMs);
}

/** Kuras semua job ai-reply tertunda di list fallback. */
export async function drainAiReplyFallback(
  redis: Redis,
): Promise<AiReplyJobPayload[]> {
  const out: AiReplyJobPayload[] = [];
  for (;;) {
    const raw = await redis.lpop(AI_REPLY_FALLBACK_KEY);
    if (!raw) break;
    try {
      out.push(JSON.parse(raw) as AiReplyJobPayload);
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}

// ---------------- Notifikasi owner ----------------

function dashboardLink(chatId: string): string {
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  return base ? `${base}/inbox?chat=${chatId}` : "dasbor /inbox";
}

function contactLabel(pn: string, name?: string | null): string {
  return name?.trim() ? `${name.trim()} (${pn})` : pn;
}

/**
 * Kirim pesan langsung ke owner via gateway (bukan lewat antrean kirim:
 * notifikasi operasional harus segera, tidak ikut limiter 20/menit).
 * Mengembalikan false bila nomor owner kosong / kirim gagal — pemanggil
 * tetap lanjut (kegagalan notifikasi dicatat, bukan dilempar).
 */
export async function notifyOwner(
  gateway: WhatsAppGateway,
  ownerWaNumber: string,
  text: string,
): Promise<boolean> {
  const pn = normalizePn(ownerWaNumber);
  if (!pn) {
    console.warn("[ai-pipeline] nomor WA owner kosong — notifikasi dilewati.");
    return false;
  }
  try {
    await gateway.send(pn, text);
    return true;
  } catch (err) {
    console.error(
      "[ai-pipeline] notifikasi owner gagal:",
      (err as Error).message,
    );
    return false;
  }
}

// ---------------- Konsumen ai-reply ----------------

export interface AiPipelineDeps {
  prisma: PrismaClient;
  redis: Redis;
  gateway: WhatsAppGateway;
  getGeneralSettings: () => Promise<GeneralSettings>;
  getChatConfig: () => Promise<EffectiveProviderConfig | null>;
  getEmbeddingConfig: () => Promise<EffectiveProviderConfig | null>;
  /** fetch untuk embedding + chat (default: global fetch; mock di test). */
  fetchImpl?: typeof fetch;
  /** Override generateReply di unit test (default: implementasi asli). */
  generateReply?: (
    input: { message: string; history: Array<{ role: "lead" | "reza"; text: string }> },
    deps: {
      prisma: PrismaClient;
      redis: Redis;
      getChatConfig: () => Promise<EffectiveProviderConfig | null>;
      getEmbeddingConfig: () => Promise<EffectiveProviderConfig | null>;
      fetchImpl?: typeof fetch;
    },
  ) => Promise<GenerateReplyResult>;
  /** Jam untuk test (default Date.now). */
  nowMs?: () => number;
  /** Jeda "mengetik" (default setTimeout asli; 0 di test). */
  sleepMs?: (ms: number) => Promise<void>;
}

export type AiReplyOutcome =
  | { status: "skipped"; reason: string }
  | { status: "rescheduled"; delayMs: number }
  | { status: "sent" }
  | { status: "draft"; draftId: string; notified: boolean }
  | { status: "handoff"; handoffId: string; notified: boolean };

/** Ringkasan 1-2 kalimat dari pesan terakhir lead (aturan sederhana, jujur). */
function summarizeLeadMessage(body: string | null): string {
  const text = (body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Lead mengirim pesan tanpa teks (mungkin media).";
  const short = text.length > 140 ? `${text.slice(0, 137)}...` : text;
  return `Lead bertanya: "${short}"`;
}

async function doHandoff(
  deps: AiPipelineDeps,
  chatId: string,
  contactPn: string,
  contactName: string | null,
  result: GenerateReplyResult,
  general: GeneralSettings,
  lastBody: string | null,
): Promise<{ status: "handoff"; handoffId: string; notified: boolean }> {
  const { prisma, redis, gateway } = deps;
  const reason = result.reason?.trim() || "AI meminta bantuan manusia";
  const summary = summarizeLeadMessage(lastBody);

  const handoff = await prisma.handoff.create({
    data: { chatId, reason, summary, status: "open" },
    select: { id: true },
  });

  // AI berhenti di chat ini sampai dilanjutkan manual (pausedUntil null
  // = jeda tanpa batas waktu).
  await prisma.chat.update({
    where: { id: chatId },
    data: { aiPaused: true, pausedUntil: null },
  });

  const text =
    `Handoff: ${contactLabel(contactPn, contactName)}.\n` +
    `Alasan: ${reason}.\n` +
    `Ringkasan: ${summary}.\n` +
    `Buka: ${dashboardLink(chatId)}`;
  const notified = await notifyOwner(gateway, general.ownerWaNumber, text);
  await prisma.handoff.update({
    where: { id: handoff.id },
    data: { notifiedAt: new Date() },
  });

  await publishInboxEvent(redis, { chatId, type: "handoff-created" });
  await publishInboxEvent(redis, { chatId, type: "chat-updated" });

  return { status: "handoff", handoffId: handoff.id, notified };
}

async function doSemiDraft(
  deps: AiPipelineDeps,
  chatId: string,
  contactPn: string,
  contactName: string | null,
  result: GenerateReplyResult,
  general: GeneralSettings,
): Promise<{ status: "draft"; draftId: string; notified: boolean }> {
  const { prisma, redis, gateway } = deps;

  const draft = await prisma.draft.create({
    data: {
      chatId,
      body: result.reply,
      status: "pending",
      confidence: result.confidence,
      reason: result.reason,
      sourcesUsed: result.sourcesUsed,
    },
    select: { id: true },
  });

  const pct = Math.round(result.confidence * 100);
  const text =
    `Draf AI untuk ${contactLabel(contactPn, contactName)} — menunggu persetujuan:\n\n` +
    `${result.reply}\n\n` +
    `Keyakinan: ${pct}%.` +
    (result.reason?.trim() ? ` Catatan: ${result.reason.trim()}` : "") +
    `\nBuka: ${dashboardLink(chatId)}`;
  const notified = await notifyOwner(gateway, general.ownerWaNumber, text);

  await publishInboxEvent(redis, { chatId, type: "draft-created" });

  return { status: "draft", draftId: draft.id, notified };
}

/**
 * Konsumen job ai-reply {chatId}. Selalu selesai tanpa melempar untuk
 * kondisi bisnis yang wajar (dijeda, ignored, mode off, dsb.) — hanya
 * kegagalan teknis (DB/Redis putus) yang dilempar agar bisa retry.
 */
export async function processAiReply(
  job: AiReplyJobPayload,
  deps: AiPipelineDeps,
): Promise<AiReplyOutcome> {
  const { prisma, redis, gateway } = deps;
  const now = deps.nowMs ? deps.nowMs() : Date.now();
  const chatId = job.chatId;

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { contact: true },
  });
  if (!chat) return { status: "skipped", reason: "chat-tidak-ditemukan" };
  if (chat.ignored) return { status: "skipped", reason: "chat-ignored" };

  const general = await deps.getGeneralSettings();

  // (a) AI dijeda — manual dari HP (pausedUntil) atau handoff (null).
  if (chat.aiPaused) {
    const until = chat.pausedUntil ? chat.pausedUntil.getTime() : Infinity;
    if (until > now) {
      return { status: "skipped", reason: "ai-dijeda" };
    }
    // pausedUntil lewat -> lanjut otomatis.
    await prisma.chat.update({
      where: { id: chatId },
      data: { aiPaused: false, pausedUntil: null },
    });
    await publishInboxEvent(redis, { chatId, type: "chat-updated" });
  }

  // (b) Debounce self-correcting: belum waktunya -> jadwalkan ulang diri.
  const until = Number((await redis.get(aiDebounceKey(chatId))) ?? 0);
  if (now < until) {
    const delayMs = until - now;
    await enqueueAiReply(redis, chatId, delayMs);
    return { status: "rescheduled", delayMs };
  }

  // (c) Lock eksekusi: hanya satu job yang mengerjakan chat ini.
  const lockKey = aiRunLockKey(chatId);
  const acquired = await redis.set(lockKey, "1", "EX", 600, "NX");
  if (acquired !== "OK") {
    return { status: "skipped", reason: "sudah-dikerjakan" };
  }

  try {
    // Cek ulang debounce SETELAH dapat lock (pesan baru bisa datang
    // di antara dua pembacaan).
    const now2 = deps.nowMs ? deps.nowMs() : Date.now();
    const until2 = Number((await redis.get(aiDebounceKey(chatId))) ?? 0);
    if (now2 < until2) {
      const delayMs = until2 - now2;
      await enqueueAiReply(redis, chatId, delayMs);
      return { status: "rescheduled", delayMs };
    }

    // (d) Pesan terakhir dari kita (mis. Reza menjawab manual di sela
    // debounce) -> tidak perlu AI membalas.
    const last = await prisma.message.findFirst({
      where: { chatId },
      orderBy: { createdAt: "desc" },
    });
    if (!last) return { status: "skipped", reason: "tanpa-pesan" };
    if (last.fromMe) return { status: "skipped", reason: "terakhir-dari-kita" };

    // (e) Riwayat + generateReply (tidak pernah throw).
    const recent = await prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: "desc" },
      take: AI_HISTORY_LIMIT,
    });
    const history = recent
      .reverse()
      .map((m) => ({
        role: (m.fromMe ? "reza" : "lead") as "lead" | "reza",
        text: (m.body ?? "").trim(),
      }))
      .filter((m) => m.text.length > 0);

    const replyFn = deps.generateReply ?? generateReply;
    const result = await replyFn(
      { message: (last.body ?? "").trim(), history },
      {
        prisma,
        redis,
        getChatConfig: deps.getChatConfig,
        getEmbeddingConfig: deps.getEmbeddingConfig,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      },
    );

    const mode = resolveMode(chat, general);
    const contactPn = chat.contact.pn;
    const contactName = chat.contact.name;

    // (f) Handoff: flag LLM/intent ATAU confidence di bawah threshold.
    if (result.handoff || result.confidence < general.handoffConfidenceThreshold) {
      return doHandoff(
        deps,
        chatId,
        contactPn,
        contactName,
        result,
        general,
        last.body,
      );
    }

    if (mode === "full") {
      // Tampilkan "mengetik…" lalu jeda acak agar terasa manusiawi.
      try {
        await gateway.presence(contactPn, "composing");
      } catch (err) {
        console.warn(
          "[ai-pipeline] presence gagal (balasan tetap dikirim):",
          (err as Error).message,
        );
      }
      const lo = Math.min(general.replyDelayMinSec, general.replyDelayMaxSec);
      const hi = Math.max(general.replyDelayMinSec, general.replyDelayMaxSec);
      const delayMs = Math.round((lo + Math.random() * (hi - lo)) * 1000);
      const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      if (delayMs > 0) await sleep(delayMs);
      await enqueueSend(redis, chatId, { text: result.reply }, "ai");
      return { status: "sent" };
    }

    if (mode === "semi") {
      return doSemiDraft(deps, chatId, contactPn, contactName, result, general);
    }

    return { status: "skipped", reason: "mode-off" };
  } finally {
    await redis.del(lockKey);
  }
}

// ---------------- Poller fallback (E2E / jaga-jaga) ----------------

/**
 * Poller list fallback untuk antrean ai-reply. Menghormati `notBefore`
 * (job yang belum waktunya dikembalikan ke list). Pola yang sama dengan
 * startSendFallbackPoller (Task 5). Mengembalikan fungsi stop().
 */
export function startAiReplyFallbackPoller(
  redis: Redis,
  deps: AiPipelineDeps,
  intervalMs = 5000,
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const items = await drainAiReplyFallback(redis);
        const now = deps.nowMs ? deps.nowMs() : Date.now();
        const deferred: AiReplyJobPayload[] = [];
        for (const payload of items) {
          if (payload.notBefore && payload.notBefore > now) {
            deferred.push(payload);
            continue;
          }
          try {
            await processAiReply(payload, deps);
          } catch (e) {
            console.error(
              "[ai-reply] job gagal:",
              (e as Error).message,
            );
          }
        }
        // Kembalikan yang belum waktunya (urutan dipertahankan).
        for (let i = deferred.length - 1; i >= 0; i--) {
          await redis.lpush(
            AI_REPLY_FALLBACK_KEY,
            JSON.stringify(deferred[i]),
          );
        }
      } catch (e) {
        console.error("[ai-reply] drain fallback gagal:", (e as Error).message);
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
