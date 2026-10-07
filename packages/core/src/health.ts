import { HEARTBEAT_TTL_MS } from "./redis.js";

export type HealthStatus = "ok" | "error";

export interface HealthResult {
  db: HealthStatus;
  redis: HealthStatus;
  worker: HealthStatus;
  ts: string;
}

/**
 * Dependensi health check — diinjeksikan supaya bisa diuji
 * dengan implementasi asli (PGlite, ioredis-mock) tanpa mock murahan.
 */
export interface HealthDeps {
  /** Ping database; throw bila gagal. */
  dbPing: () => Promise<unknown>;
  /** Ping redis; throw bila gagal. */
  redisPing: () => Promise<unknown>;
  /** Baca nilai mentah key heartbeat worker (string | null). */
  getHeartbeat: () => Promise<string | null>;
  /** Jam sekarang (ms epoch). Default Date.now — override di test. */
  now?: () => number;
}

/**
 * Health check REAL: setiap komponen benar-benar dites.
 * worker = "ok" hanya bila heartbeat < 60 detik.
 */
export async function checkHealth(deps: HealthDeps): Promise<HealthResult> {
  const now = (deps.now ?? Date.now)();

  let db: HealthStatus = "ok";
  let redis: HealthStatus = "ok";
  let worker: HealthStatus = "ok";

  try {
    await deps.dbPing();
  } catch {
    db = "error";
  }

  try {
    await deps.redisPing();
  } catch {
    redis = "error";
  }

  try {
    const raw = await deps.getHeartbeat();
    const ts = raw === null ? NaN : Number(raw);
    worker =
      raw !== null && Number.isFinite(ts) && now - ts < HEARTBEAT_TTL_MS ? "ok" : "error";
  } catch {
    worker = "error";
  }

  return { db, redis, worker, ts: new Date(now).toISOString() };
}
