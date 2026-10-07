import { createRedisClient, prisma } from "@reza-ai/core";
import type Redis from "ioredis";

// Singleton klien Redis untuk proses server Next.js.
// Route Handler & Server Component memakai ini; unit test mengoper
// instance sendiri (ioredis-mock) ke fungsi-fungsi di auth.ts.
const globalForRedis = globalThis as unknown as { rezaRedis?: Redis };

export function getRedis(): Redis {
  if (!globalForRedis.rezaRedis) {
    globalForRedis.rezaRedis = createRedisClient();
  }
  return globalForRedis.rezaRedis;
}

export { prisma };
