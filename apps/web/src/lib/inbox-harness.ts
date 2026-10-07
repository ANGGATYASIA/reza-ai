import {
  FakeGateway,
  enqueueIngest,
  getEffectiveProviderConfig,
  getGeneralSettings,
  prisma,
  startAiReplyFallbackPoller,
  startIngestFallbackPoller,
  startSendFallbackPoller,
  type AiPipelineDeps,
  type InboundMessage,
} from "@reza-ai/core";
import { getRedis } from "./server";

/**
 * Harness E2E inbox — HANYA dipakai saat E2E_TEST_API=1.
 *
 * Kenapa in-process (bukan worker asli sebagai proses terpisah)?
 * E2E sandbox memakai REDIS_URL=memory:// (ioredis-mock) yang datanya
 * hanya hidup di memori SATU proses — tidak bisa dibagi antara proses
 * web dan proses worker. PGlite pun tidak boleh dibuka dua proses
 * pada dataDir yang sama. Karena itu harness ini menjalankan "worker
 * mini" di dalam proses server Next.js.
 *
 * Yang REAL (kode produksi yang sama dipakai apps/worker):
 * - FakeGateway + gateway.onMessage -> enqueueIngest (core)
 * - startIngestFallbackPoller -> processInboundMessage (core)
 * - startSendFallbackPoller -> processSendJob + limiter (core)
 * - startAiReplyFallbackPoller -> processAiReply: debounce -> generateReply
 *   -> mode -> kirim/draf/handoff (core)
 * - publish event reza:inbox -> SSE /api/inbox/stream -> UI
 * - Prisma -> PGlite yang sama dengan web
 *
 * Yang DISIMULASIKAN: hanya gateway-nya (FakeGateway, bukan Baileys)
 * dan transport antreannya (list fallback, bukan BullMQ — BullMQ butuh
 * skrip Lua Redis asli; pola yang sama dengan wa-command di Task 4).
 * Test memicu pesan via gateway.simulateIncoming(), persis seperti
 * Baileys memicu onMessage di produksi.
 */
export interface InboxHarness {
  gateway: FakeGateway;
  stop: () => void;
}

const globalForHarness = globalThis as unknown as {
  rezaInboxHarness?: InboxHarness;
};

export function getInboxHarness(): InboxHarness | undefined {
  return globalForHarness.rezaInboxHarness;
}

export function startInboxHarness(): InboxHarness {
  const existing = globalForHarness.rezaInboxHarness;
  if (existing) return existing;

  const redis = getRedis();
  const gateway = new FakeGateway();
  void gateway.connect();

  const ingestDeps = {
    prisma,
    redis,
    getOwnerNumber: () =>
      getGeneralSettings().then((s) => s.ownerWaNumber),
    getGeneralSettings,
  };
  const sendDeps = { prisma, redis, gateway };
  // Task 8: konsumen ai-reply (fungsi produksi yang sama dipakai
  // apps/worker). Slot chat/embedding diarahkan test ke server mock
  // lokal via /api/test/playground/mock-chat & /api/test/knowledge/mock-embedding.
  const aiDeps: AiPipelineDeps = {
    prisma,
    redis,
    gateway,
    getGeneralSettings,
    getChatConfig: () => getEffectiveProviderConfig("chat"),
    getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
  };

  gateway.onMessage((msg: InboundMessage) => {
    // Lewati cermin kiriman gateway sendiri (sudah dicatat saat mengirim).
    if (msg.fromMe && gateway.wasRecentlySent(msg.id)) return;
    void enqueueIngest(redis, msg).catch((e) =>
      console.error("[harness] enqueue ingest gagal:", (e as Error).message),
    );
  });

  // Poller cepat (250ms) supaya E2E tidak menunggu lama.
  const stopIngest = startIngestFallbackPoller(redis, ingestDeps, 250);
  const stopSend = startSendFallbackPoller(redis, sendDeps, 250);
  const stopAiReply = startAiReplyFallbackPoller(redis, aiDeps, 250);

  const harness: InboxHarness = {
    gateway,
    stop: () => {
      stopIngest();
      stopSend();
      stopAiReply();
      delete globalForHarness.rezaInboxHarness;
    },
  };
  globalForHarness.rezaInboxHarness = harness;
  console.log("[harness] inbox E2E aktif (FakeGateway + poller 250ms).");
  return harness;
}
