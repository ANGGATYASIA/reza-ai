import { HEARTBEAT_KEY, checkHealth, createRedisClient, prisma } from "@reza-ai/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 * Status REAL — setiap komponen benar-benar dites:
 * - db:     query `SELECT 1` via Prisma
 * - redis:  PING via ioredis
 * - worker: heartbeat worker < 60 detik (key reza:worker:heartbeat)
 */
export async function GET() {
  const redis = createRedisClient();
  try {
    const result = await checkHealth({
      dbPing: () => prisma.$queryRaw`SELECT 1`,
      redisPing: () => redis.ping(),
      getHeartbeat: () => redis.get(HEARTBEAT_KEY),
    });
    const status = result.db === "ok" && result.redis === "ok" && result.worker === "ok" ? 200 : 503;
    return NextResponse.json(result, { status });
  } finally {
    redis.disconnect();
  }
}
