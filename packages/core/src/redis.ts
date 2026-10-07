import Redis from "ioredis";
import RedisMock from "ioredis-mock";

/** Prefix untuk semua key Reza AI di Redis. */
export const QUEUE_PREFIX = "reza";

/** Key heartbeat worker. Nilai = timestamp ms (Date.now()). */
export const HEARTBEAT_KEY = "reza:worker:heartbeat";

/** Batas usia heartbeat agar dianggap hidup (ms). */
export const HEARTBEAT_TTL_MS = 60_000;

export interface RedisClientOptions {
  url?: string;
  maxRetriesPerRequest?: number | null;
}

/**
 * True bila REDIS_URL memakai mode in-memory (REDIS_URL=memory://).
 * Dipakai modul antrean untuk memilih transport: BullMQ di Redis asli,
 * Redis list fallback di E2E (BullMQ butuh skrip Lua asli yang tidak
 * didukung ioredis-mock).
 */
export function isMockRedis(url?: string): boolean {
  const u = url ?? process.env.REDIS_URL ?? "";
  return u === "memory://" || u.startsWith("memory://");
}

/**
 * Membuat klien ioredis dari REDIS_URL (default redis://localhost:6379).
 * Satu instance per proses; tutup dengan .quit() saat shutdown.
 *
 * Mode khusus: REDIS_URL=memory:// memakai implementasi Redis in-memory
 * (ioredis-mock) di memori proses ini. HANYA untuk E2E di sandbox yang
 * tidak punya redis-server native. Ini BUKAN server Redis asli: data hilang
 * saat proses mati dan tidak bisa dibagi antar proses. Di VPS/docker-compose
 * selalu pakai Redis asli via REDIS_URL=redis://...
 */
export function createRedisClient(opts: RedisClientOptions = {}): Redis {
  const url = opts.url ?? process.env.REDIS_URL ?? "redis://localhost:6379";
  if (url === "memory://" || url.startsWith("memory://")) {
    console.warn(
      "[reza-ai/core] REDIS_URL=memory:// — memakai Redis in-memory " +
        "(bukan server asli). Hanya untuk E2E sandbox.",
    );
    return new RedisMock() as unknown as Redis;
  }
  return new Redis(url, {
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? null,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
