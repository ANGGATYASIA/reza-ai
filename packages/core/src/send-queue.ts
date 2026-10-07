import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { WhatsAppGateway } from "./gateway.js";
import { isPseudoPn, publishInboxEvent } from "./ingest.js";
import { isMockRedis, QUEUE_PREFIX } from "./redis.js";

/**
 * Antrean kirim (Task 5).
 *
 * Alur: UI /inbox (atau AI di Task 6+) -> enqueueSend() -> antrean BullMQ
 * `send` -> worker consumer -> processSendJob():
 *   cek limiter global -> gateway.send()/sendMedia() ->
 *   simpan Message {fromMe: true, source: "dashboard"|"ai"} ->
 *   publish event inbox.
 *
 * Di E2E (REDIS_URL=memory://) BullMQ tidak jalan (butuh Lua asli):
 * enqueueSend mencatat ke Redis list fallback, dikuras via
 * drainSendFallback() / startSendFallbackPoller() — pola yang sama
 * dengan wa-command (Task 4).
 */

// ---------------- Limiter ----------------

/** Batas kirim global: 20 pesan per menit (fixed window, per menit kalender). */
export const SEND_LIMIT_PER_MINUTE = 20;
export const SEND_LIMIT_WINDOW_SEC = 60;

/** Key jeda fallback saat limiter penuh (dipakai poller list fallback). */
export const SEND_PAUSE_KEY = "reza:send:paused-until";

function limitKey(nowMs: number): string {
  return `reza:send:limit:${Math.floor(nowMs / (SEND_LIMIT_WINDOW_SEC * 1000))}`;
}

export class SendRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(
      `Batas kirim tercapai (maks ${SEND_LIMIT_PER_MINUTE} pesan/menit). ` +
        `Coba lagi dalam ${Math.ceil(retryAfterMs / 1000)} detik.`,
    );
    this.name = "SendRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Fixed-window limiter global. Setiap panggilan memakai satu slot —
 * termasuk panggilan yang nantinya ditolak (mencegah retry storm).
 * Panggilan ke-21 dalam satu menit kalender -> { allowed: false }.
 */
export async function checkSendLimit(
  redis: Redis,
  nowMs = Date.now(),
): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const key = limitKey(nowMs);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, SEND_LIMIT_WINDOW_SEC * 2);
  if (count > SEND_LIMIT_PER_MINUTE) {
    const windowEnd =
      (Math.floor(nowMs / (SEND_LIMIT_WINDOW_SEC * 1000)) + 1) *
      SEND_LIMIT_WINDOW_SEC *
      1000;
    return { allowed: false, retryAfterMs: Math.max(0, windowEnd - nowMs) };
  }
  return { allowed: true, retryAfterMs: 0 };
}

// ---------------- Payload & transport ----------------

/** Nama antrean BullMQ (terdaftar di QUEUE_NAMES). */
export const SEND_QUEUE = "send" as const;

/** List fallback untuk E2E (pola wa-command Task 4). */
export const SEND_FALLBACK_KEY = "reza:send:fallback";

export interface SendContent {
  text?: string;
  mediaPath?: string;
  caption?: string;
}

export interface SendJobPayload {
  chatId: string;
  content: SendContent;
  /**
   * "dashboard" = dikirim manual dari /inbox;
   * "ai" = balasan agen Reza AI (Task 6+).
   */
  source: "dashboard" | "ai";
  requestedBy?: string;
  /** Test-only: jangan proses sebelum timestamp ini (dipakai ulang antre). */
  notBefore?: number;
}

function mediaTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) return "image";
  if (["mp4", "mov", "3gp"].includes(ext)) return "video";
  if (["mp3", "ogg", "opus", "m4a"].includes(ext)) return "audio";
  return "document";
}

/**
 * Masukkan permintaan kirim ke antrean `send`.
 * Mengembalikan transport yang dipakai ("bullmq" produksi, "list" E2E).
 */
export async function enqueueSend(
  redis: Redis,
  chatId: string,
  content: SendContent,
  source: SendJobPayload["source"],
  requestedBy?: string,
): Promise<{ transport: "bullmq" | "list" }> {
  if (!chatId) throw new Error("enqueueSend: chatId wajib diisi.");
  const text = content.text?.trim();
  if (!text && !content.mediaPath) {
    throw new Error("enqueueSend: text atau mediaPath wajib diisi.");
  }
  const payload: SendJobPayload = {
    chatId,
    content: { ...content, text },
    source,
    requestedBy,
  };

  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(SEND_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add("send-message", payload, {
          removeOnComplete: 1000,
          removeOnFail: 500,
        });
      } finally {
        await queue.close();
      }
      return { transport: "bullmq" };
    } catch (err) {
      console.warn(
        "[reza-ai/core] enqueueSend via BullMQ gagal, pakai list fallback:",
        (err as Error).message,
      );
    }
  }

  await redis.rpush(SEND_FALLBACK_KEY, JSON.stringify(payload));
  return { transport: "list" };
}

/** Kuras semua job kirim tertunda di list fallback (tanpa notBefore). */
export async function drainSendFallback(
  redis: Redis,
): Promise<SendJobPayload[]> {
  const out: SendJobPayload[] = [];
  for (;;) {
    const raw = await redis.lpop(SEND_FALLBACK_KEY);
    if (!raw) break;
    try {
      out.push(JSON.parse(raw) as SendJobPayload);
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}

// ---------------- Eksekusi job ----------------

export interface SendDeps {
  prisma: PrismaClient;
  redis: Redis;
  gateway: WhatsAppGateway;
  /** Jam untuk test (default Date.now). */
  nowMs?: () => number;
}

/**
 * Eksekusi satu job kirim: validasi chat -> cek limiter ->
 * gateway.send()/sendMedia() -> simpan Message {fromMe: true} ->
 * publish event inbox.
 *
 * Melempar SendRateLimitedError bila limiter penuh (worker menjadwalkan
 * ulang dengan delay), Error biasa untuk masalah lain (chat hilang,
 * kontak semu, gateway gagal).
 */
export async function processSendJob(
  payload: SendJobPayload,
  deps: SendDeps,
): Promise<{ messageId: string }> {
  const { prisma, redis, gateway } = deps;
  const now = deps.nowMs ? deps.nowMs() : Date.now();

  const chat = await prisma.chat.findUnique({
    where: { id: payload.chatId },
    include: { contact: true },
  });
  if (!chat) {
    throw new Error(`processSendJob: chat ${payload.chatId} tidak ditemukan.`);
  }
  const to = chat.contact.pn;
  if (isPseudoPn(to)) {
    throw new Error(
      `processSendJob: tidak bisa mengirim ke kontak semu "${to}".`,
    );
  }

  const limit = await checkSendLimit(redis, now);
  if (!limit.allowed) throw new SendRateLimitedError(limit.retryAfterMs);

  const text = payload.content.text?.trim() || undefined;
  let messageId: string;
  let mediaType: string | null = null;
  let body: string | null = null;
  if (payload.content.mediaPath) {
    const res = await gateway.sendMedia(
      to,
      payload.content.mediaPath,
      payload.content.caption,
    );
    messageId = res.messageId;
    mediaType = mediaTypeFromPath(payload.content.mediaPath);
    body = payload.content.caption ?? null;
  } else {
    const res = await gateway.send(to, text as string);
    messageId = res.messageId;
    body = text ?? null;
  }

  const created = await prisma.message.create({
    data: {
      chatId: chat.id,
      waMessageId: messageId,
      fromMe: true,
      body,
      mediaType,
      source: payload.source,
    },
    select: { id: true },
  });

  await prisma.chat.update({
    where: { id: chat.id },
    data: { updatedAt: new Date() },
  });

  await publishInboxEvent(redis, {
    chatId: chat.id,
    messageId: created.id,
    type: "new-message",
  });

  return { messageId };
}

/**
 * Poller fallback untuk antrean send. Saat limiter penuh, job dikembalikan
 * ke list dan poller jeda sampai window berikutnya (key SEND_PAUSE_KEY).
 * Mengembalikan fungsi stop().
 */
export function startSendFallbackPoller(
  redis: Redis,
  deps: SendDeps,
  intervalMs = 5000,
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const pausedUntil = Number((await redis.get(SEND_PAUSE_KEY)) ?? 0);
        if (Date.now() < pausedUntil) return;
        const items = await drainSendFallback(redis);
        for (const payload of items) {
          try {
            await processSendJob(payload, deps);
          } catch (e) {
            if (e instanceof SendRateLimitedError) {
              await redis.set(
                SEND_PAUSE_KEY,
                String(Date.now() + e.retryAfterMs),
                "EX",
                180,
              );
              await redis.rpush(SEND_FALLBACK_KEY, JSON.stringify(payload));
              break;
            }
            console.error(
              "[send] job gagal:",
              (e as Error).message,
            );
          }
        }
      } catch (e) {
        console.error("[send] drain fallback gagal:", (e as Error).message);
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
