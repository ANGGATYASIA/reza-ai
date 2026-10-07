import type Redis from "ioredis";
import { isMockRedis, QUEUE_PREFIX } from "./redis.js";
import { QUEUE_NAMES } from "./queues.js";

/**
 * Perintah dashboard -> worker untuk koneksi WhatsApp.
 * - "logout":  hapus sesi auth + putuskan koneksi + mulai ulang (QR baru).
 * - "restart": paksa reconnect (socket lama ditutup dulu).
 */
export type WaCommand = "logout" | "restart";

export interface WaCommandPayload {
  command: WaCommand;
  by: string;
  ts: number;
}

/** Nama queue BullMQ (terdaftar di QUEUE_NAMES). */
export const WA_COMMAND_QUEUE = "wa-command" as const;

if (!QUEUE_NAMES.includes(WA_COMMAND_QUEUE)) {
  throw new Error("wa-command belum terdaftar di QUEUE_NAMES");
}

/**
 * Fallback transport: Redis list.
 * BullMQ butuh skrip Lua asli — tidak jalan di atas ioredis-mock
 * (dipakai E2E: REDIS_URL=memory://). Di lingkungan itu perintah
 * dicatat ke list ini; worker mengurasnya via drainWaCommandFallback().
 * Di produksi (Redis asli) jalur ini tidak pernah dipakai.
 */
export const WA_COMMAND_FALLBACK_KEY = "reza:wa:command:fallback";

/**
 * Kirim perintah ke worker. Mengembalikan transport yang dipakai
 * ("bullmq" di produksi, "list" di E2E mock) — jujur untuk diagnosis.
 */
export async function enqueueWaCommand(
  redis: Redis,
  command: WaCommand,
  by = "dashboard",
): Promise<{ payload: WaCommandPayload; transport: "bullmq" | "list" }> {
  const payload: WaCommandPayload = { command, by, ts: Date.now() };

  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(WA_COMMAND_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add(command, payload, {
          removeOnComplete: 100,
          removeOnFail: 100,
        });
        return { payload, transport: "bullmq" };
      } finally {
        await queue.close();
      }
    } catch (err) {
      // Redis tidak mendukung Lua BullMQ (atau error lain): fallback ke list.
      console.warn(
        "[reza-ai/core] enqueueWaCommand via BullMQ gagal, pakai list fallback:",
        (err as Error).message,
      );
    }
  }

  await redis.rpush(WA_COMMAND_FALLBACK_KEY, JSON.stringify(payload));
  return { payload, transport: "list" };
}

/** Kuras semua perintah tertunda di list fallback (dipakai worker + API test). */
export async function drainWaCommandFallback(
  redis: Redis,
): Promise<WaCommandPayload[]> {
  const out: WaCommandPayload[] = [];
  for (;;) {
    const raw = await redis.lpop(WA_COMMAND_FALLBACK_KEY);
    if (!raw) break;
    try {
      out.push(JSON.parse(raw) as WaCommandPayload);
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}

/** Intip isi list fallback tanpa menguras (untuk endpoint test-only). */
export async function peekWaCommandFallback(
  redis: Redis,
): Promise<WaCommandPayload[]> {
  const raws = await redis.lrange(WA_COMMAND_FALLBACK_KEY, 0, -1);
  const out: WaCommandPayload[] = [];
  for (const raw of raws) {
    try {
      out.push(JSON.parse(raw) as WaCommandPayload);
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}
