import {
  getGeneralSettings,
  ingestKnowledgeItem,
  prisma,
  startIngestFallbackPoller,
  startReindexFallbackPoller,
} from "@reza-ai/core";
import { getRedis } from "./server";
import { getKnowledgeDeps } from "./knowledge-server";

/**
 * Harness E2E knowledge — HANYA dipakai saat E2E_TEST_API=1.
 *
 * Kenapa in-process: sama seperti inbox-harness (Task 5) — REDIS_URL=memory://
 * (ioredis-mock) tidak lintas-proses dan satu dataDir PGlite tidak boleh
 * dibuka dua proses.
 *
 * Yang REAL (kode produksi yang sama dipakai apps/worker):
 * - POST /api/knowledge/items -> enqueueKnowledgeIngest (core)
 * - poller 250ms -> ingestKnowledgeItem REAL (extract -> chunk ->
 *   embedBatch -> PGlite) — termasuk unpdf & Readability bila dipakai
 * - POST /api/knowledge/reindex -> enqueueReindex -> poller ->
 *   reindexAll REAL
 * - POST /api/knowledge/search -> hybridSearch REAL
 *
 * Yang DISIMULASIKAN: hanya provider embedding-nya (server HTTP mock
 * di file spec, vektor hash deterministik — didokumentasikan di
 * docs/demo-task-6.md), dan transport antreannya (list fallback,
 * bukan BullMQ — BullMQ butuh skrip Lua Redis asli).
 */

export interface KnowledgeHarness {
  stop: () => void;
}

const globalForHarness = globalThis as unknown as {
  rezaKnowledgeHarness?: KnowledgeHarness;
};

export function getKnowledgeHarness(): KnowledgeHarness | undefined {
  return globalForHarness.rezaKnowledgeHarness;
}

export function startKnowledgeHarness(): KnowledgeHarness {
  const existing = globalForHarness.rezaKnowledgeHarness;
  if (existing) return existing;

  const redis = getRedis();
  const deps = getKnowledgeDeps();

  const stopIngest = startIngestFallbackPoller(
    redis,
    {
      prisma,
      redis,
      getOwnerNumber: async () => "",
      getGeneralSettings,
    },
    250,
    {
      processKnowledgeItem: (itemId: string) =>
        ingestKnowledgeItem(itemId, deps),
    },
  );
  const stopReindex = startReindexFallbackPoller(redis, deps, 250);

  const harness: KnowledgeHarness = {
    stop: () => {
      stopIngest();
      stopReindex();
      delete globalForHarness.rezaKnowledgeHarness;
    },
  };
  globalForHarness.rezaKnowledgeHarness = harness;
  console.log("[harness] knowledge E2E aktif (poller ingest+reindex 250ms).");
  return harness;
}
