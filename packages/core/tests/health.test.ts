import { PGlite } from "@electric-sql/pglite";
import Redis from "ioredis-mock";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkHealth, HEARTBEAT_KEY, type HealthDeps } from "../src/index.js";

/**
 * Test integrasi health check dengan dependensi ASLI (bukan mock murahan):
 * - dbPing: query `SELECT 1` sungguhan via PGlite (Postgres asli, WASM)
 * - redisPing: PING sungguhan via ioredis-mock (implementasi protokol Redis)
 * - heartbeat: SET/GET key asli + fake timer untuk simulasi basi
 *
 * Di VPS/CI, ganti PGlite -> postgres asli & ioredis-mock -> ioredis
 * ke REDIS_URL asli; logika checkHealth tidak berubah.
 */

let pg: PGlite;
let redis: InstanceType<typeof Redis>;

function realDeps(now: () => number, heartbeatValue: () => Promise<string | null>): HealthDeps {
  return {
    dbPing: () => pg.query("SELECT 1"),
    redisPing: () => redis.ping(),
    getHeartbeat: heartbeatValue,
    now,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  redis = new Redis();
});

afterAll(async () => {
  await pg.close();
  redis.disconnect();
});

describe("checkHealth — semua komponen sehat", () => {
  it("db/redis/worker = ok saat SELECT 1 lolos, PING lolos, heartbeat segar", async () => {
    const nowMs = Date.now();
    await redis.set(HEARTBEAT_KEY, String(nowMs));
    const res = await checkHealth(
      realDeps(() => nowMs, () => redis.get(HEARTBEAT_KEY)),
    );
    expect(res.db).toBe("ok");
    expect(res.redis).toBe("ok");
    expect(res.worker).toBe("ok");
    expect(res.ts).toBe(new Date(nowMs).toISOString());
  });
});

describe("checkHealth — worker mati / heartbeat basi", () => {
  it("worker = error bila key heartbeat tidak ada", async () => {
    await redis.del(HEARTBEAT_KEY);
    const res = await checkHealth(realDeps(Date.now, () => redis.get(HEARTBEAT_KEY)));
    expect(res.worker).toBe("error");
    expect(res.db).toBe("ok");
    expect(res.redis).toBe("ok");
  });

  it("worker = error bila heartbeat lebih tua dari 60 detik", async () => {
    const t0 = 1_700_000_000_000;
    await redis.set(HEARTBEAT_KEY, String(t0));
    // Simulasi waktu berjalan 61 detik tanpa heartbeat baru
    const res = await checkHealth(realDeps(() => t0 + 61_000, () => redis.get(HEARTBEAT_KEY)));
    expect(res.worker).toBe("error");
  });

  it("worker = ok bila heartbeat 59 detik lalu", async () => {
    const t0 = 1_700_000_000_000;
    await redis.set(HEARTBEAT_KEY, String(t0));
    const res = await checkHealth(realDeps(() => t0 + 59_000, () => redis.get(HEARTBEAT_KEY)));
    expect(res.worker).toBe("ok");
  });

  it("worker pulih: error -> ok setelah heartbeat ditulis lagi", async () => {
    await redis.del(HEARTBEAT_KEY);
    const before = await checkHealth(realDeps(Date.now, () => redis.get(HEARTBEAT_KEY)));
    expect(before.worker).toBe("error");

    await redis.set(HEARTBEAT_KEY, String(Date.now()));
    const after = await checkHealth(realDeps(Date.now, () => redis.get(HEARTBEAT_KEY)));
    expect(after.worker).toBe("ok");
  });
});

describe("checkHealth — kegagalan komponen", () => {
  it("db = error bila query gagal, komponen lain tetap dicek", async () => {
    const res = await checkHealth({
      dbPing: () => Promise.reject(new Error("connection refused")),
      redisPing: () => redis.ping(),
      getHeartbeat: () => redis.get(HEARTBEAT_KEY),
      now: Date.now,
    });
    expect(res.db).toBe("error");
    expect(res.redis).toBe("ok");
  });

  it("redis = error bila PING gagal; worker ikut error karena baca dari redis", async () => {
    const dead = { ping: () => Promise.reject(new Error("ECONNREFUSED")), get: () => Promise.reject(new Error("ECONNREFUSED")) };
    const res = await checkHealth({
      dbPing: () => pg.query("SELECT 1"),
      redisPing: () => dead.ping(),
      getHeartbeat: () => dead.get(),
      now: Date.now,
    });
    expect(res.redis).toBe("error");
    expect(res.worker).toBe("error");
    expect(res.db).toBe("ok");
  });

  it("nilai heartbeat bukan angka -> worker error (bukan crash)", async () => {
    await redis.set(HEARTBEAT_KEY, "bukan-angka");
    const res = await checkHealth(realDeps(Date.now, () => redis.get(HEARTBEAT_KEY)));
    expect(res.worker).toBe("error");
  });
});

describe("checkHealth — memakai vi fake timers untuk simulasi basi", () => {
  it("heartbeat basi terdeteksi dengan waktu virtual", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-06T23:00:00+07:00"));
      await redis.set(HEARTBEAT_KEY, String(Date.now()));
      vi.setSystemTime(new Date("2026-10-06T23:01:30+07:00")); // +90 detik
      const res = await checkHealth(realDeps(Date.now, () => redis.get(HEARTBEAT_KEY)));
      expect(res.worker).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });
});
