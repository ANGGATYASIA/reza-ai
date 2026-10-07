import {
  getEffectiveProviderConfig,
  prisma,
  type KnowledgeDeps,
} from "@reza-ai/core";
import { getRedis } from "./server";

/**
 * Dependensi knowledge untuk Route Handler: Prisma + Redis singleton
 * + config embedding efektif (resolusi inherit + dekripsi API key).
 */
export function getKnowledgeDeps(): KnowledgeDeps {
  const redis = getRedis();
  return {
    prisma,
    redis,
    getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
  };
}
