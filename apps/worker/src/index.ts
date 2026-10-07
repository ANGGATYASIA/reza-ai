import {
  HEARTBEAT_KEY,
  QUEUE_NAMES,
  SendRateLimitedError,
  createRedisClient,
  getEffectiveProviderConfig,
  getGeneralSettings,
  ingestKnowledgeItem,
  isKnowledgeIngestPayload,
  isMockRedis,
  prisma,
  type QueueName,
  processAiReply,
  processInboundMessage,
  processSendJob,
  startAiReplyFallbackPoller,
  startIngestFallbackPoller,
  reindexAll,
  startReindexFallbackPoller,
  startSendFallbackPoller,
  type AiPipelineDeps,
  type AiReplyJobPayload,
  type InboundMessage,
  type IngestDeps,
  type KnowledgeDeps,
  type SendDeps,
  type SendJobPayload,
} from "@reza-ai/core";
import type Redis from "ioredis";
import { registerQueues, type QueueProcessor, type QueueRegistry } from "./queues.js";
import { startWhatsApp, type WhatsAppManager } from "./whatsapp.js";

const HEARTBEAT_INTERVAL_MS =
  Number(process.env.WORKER_HEARTBEAT_INTERVAL ?? 15) * 1000;

let shuttingDown = false;

async function writeHeartbeat(redis: Redis): Promise<void> {
  // EX 90: kalau worker mati mendadak, key kedaluwarsa sendiri.
  // /api/health menganggap worker hidup bila heartbeat < 60 detik.
  await redis.set(HEARTBEAT_KEY, String(Date.now()), "EX", 90);
}

async function main(): Promise<void> {
  console.log("[worker] Reza AI worker mulai...");
  console.log(`[worker] Antrian: ${QUEUE_NAMES.join(", ")}`);

  const redis = createRedisClient();
  redis.on("error", (err) => console.error("[worker] Redis error:", err.message));

  // Koneksi WhatsApp (Task 4): QR + status dipublish ke Redis,
  // perintah logout/restart dikonsumsi dari queue wa-command.
  // WA_GATEWAY=fake memakai FakeGateway (Task 5, tanpa QR/jaringan).
  const waManager: WhatsAppManager = await startWhatsApp({ redis });

  // Dependensi consumer Task 5 (fungsi murni dari @reza-ai/core —
  // dipakai juga oleh unit test & harness E2E).
  const ingestDeps: IngestDeps = {
    prisma,
    redis,
    getOwnerNumber: () =>
      getGeneralSettings().then((s) => s.ownerWaNumber),
    getGeneralSettings,
  };
  const sendDeps: SendDeps = { prisma, redis, gateway: waManager.gateway };
  // Task 8: dependensi pipeline AI (debounce -> generateReply -> mode ->
  // kirim/draf/handoff).
  const aiDeps: AiPipelineDeps = {
    prisma,
    redis,
    gateway: waManager.gateway,
    getGeneralSettings,
    getChatConfig: () => getEffectiveProviderConfig("chat"),
    getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
  };
  // Task 6: dependensi knowledge (ingest item + reindex embeddings).
  const knowledgeDeps: KnowledgeDeps = {
    prisma,
    redis,
    getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
  };

  // Prosesor antrian (dipakai BullMQ di Redis asli).
  const processors: Partial<Record<QueueName, QueueProcessor>> = {
    "wa-command": (job) => waManager.handleCommand(job),
    // Task 5: simpan pesan masuk -> Contact/Chat/Message + event inbox.
    // Task 6: payload {kind:"knowledge-item"} -> ingestKnowledgeItem.
    ingest: (job) => {
      const data = job.data as unknown;
      if (isKnowledgeIngestPayload(data)) {
        return ingestKnowledgeItem(data.itemId, knowledgeDeps);
      }
      return processInboundMessage(data as InboundMessage, ingestDeps);
    },
    // Task 6: embed ulang seluruh chunk (dipicu tombol UI / ganti model).
    reindex: async () => {
      const cfg = await getEffectiveProviderConfig("embedding");
      if (!cfg || !cfg.enabled) {
        throw new Error("Slot embedding belum dikonfigurasi/aktif.");
      }
      await reindexAll(cfg, knowledgeDeps);
    },
    // Task 8: pipeline AI — debounce -> generateReply -> mode ->
    // kirim (full) / draf (semi) / handoff.
    "ai-reply": (job) => processAiReply(job.data as AiReplyJobPayload, aiDeps),
    // Task 5: kirim via gateway dengan limiter global.
    send: async (job) => {
      try {
        await processSendJob(job.data as SendJobPayload, sendDeps);
      } catch (err) {
        if (err instanceof SendRateLimitedError) {
          // Limiter penuh: jadwalkan ulang di window berikutnya
          // (job ini selesai tanpa error agar tidak retry membabi buta).
          // Hanya tercapai di mode BullMQ (Redis asli) — registry pasti ada.
          await registry!.queues.send.add(
            "send-message",
            job.data as SendJobPayload,
            {
              delay: err.retryAfterMs,
              removeOnComplete: 1000,
              removeOnFail: 500,
            },
          );
          console.log(
            `[worker:send] limiter penuh — dijadwalkan ulang ${Math.ceil(err.retryAfterMs / 1000)} dtk.`,
          );
          return;
        }
        throw err;
      }
    },
  };

  // BullMQ Worker butuh skrip Lua Redis asli — di ioredis-mock ia masuk
  // hot loop error dan membuat event loop jenuh. Mode mock (sandbox/E2E)
  // diproses oleh poller list fallback di bawah, jadi worker BullMQ
  // sengaja tidak dibuat.
  let registry: QueueRegistry | null = null;
  if (!isMockRedis()) {
    registry = registerQueues(redis, processors);
  } else {
    console.log("[worker] REDIS_URL=memory:// — BullMQ dilewati, pakai poller fallback.");
  }

  // Poller list fallback (E2E / Redis mock — pola Task 4).
  // Di produksi (Redis asli) list kosong: no-op yang murah.
  // Poller ingest juga menangani job knowledge-item (Task 6).
  const stopIngestPoller = startIngestFallbackPoller(redis, ingestDeps, 5000, {
    processKnowledgeItem: (itemId: string) =>
      ingestKnowledgeItem(itemId, knowledgeDeps),
  });
  const stopSendPoller = startSendFallbackPoller(redis, sendDeps);
  const stopReindexPoller = startReindexFallbackPoller(redis, knowledgeDeps);
  // Task 8: jaga-jaga bila BullMQ ai-reply gagal / Redis mock (E2E).
  const stopAiReplyPoller = startAiReplyFallbackPoller(redis, aiDeps, 5000);
  waManager.startFallbackPoller();
  console.log(
    `[worker] ${QUEUE_NAMES.length} antrian terdaftar (wa-command, ingest, send, reindex, ai-reply aktif; sisanya placeholder).`,
  );

  await writeHeartbeat(redis);
  console.log(`[worker] Heartbeat aktif tiap ${HEARTBEAT_INTERVAL_MS / 1000} dtk -> ${HEARTBEAT_KEY}`);

  const timer = setInterval(() => {
    if (shuttingDown) return;
    writeHeartbeat(redis).catch((err) =>
      console.error("[worker] Gagal tulis heartbeat:", err.message),
    );
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] Menerima ${signal} — shutdown rapi...`);
    clearInterval(timer);
    try {
      stopIngestPoller();
      stopSendPoller();
      stopReindexPoller();
      stopAiReplyPoller();
      await waManager.close();
      await registry?.close();
      redis.disconnect();
      console.log("[worker] Antrian, WhatsApp & koneksi Redis ditutup.");
    } catch (err) {
      console.error("[worker] Error saat shutdown:", (err as Error).message);
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] Fatal:", err);
  process.exit(1);
});
