import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { InboundMessage } from "./gateway.js";
import { isMockRedis, QUEUE_PREFIX } from "./redis.js";
import { publishInboxEvent } from "./inbox-events.js";
import { scheduleAiReply } from "./ai-pipeline.js";
import type { GeneralSettings } from "./providers.js";
import {
  isBroadcastJid,
  isGroupJid,
  lidToJid,
  normalizePn,
  pnToJid,
  shouldIgnoreChat,
} from "./wa-jid.js";

/**
 * Ingest pesan WhatsApp (Task 5).
 *
 * `processInboundMessage` adalah fungsi murni (pure) terhadap dependensinya:
 * dipakai worker produksi (apps/worker, via antrean BullMQ `ingest`) DAN
 * dipakai langsung oleh unit test / harness E2E. Seluruh keputusan
 * filter & mapping LID<->PN hidup di sini, bukan di worker.
 */

// ---------------- Event inbox realtime ----------------
// (definisi kanonis di inbox-events.ts — modul ini re-export agar consumer
// lama tidak rusak; ai-pipeline.ts mengimpor langsung dari sana)
export {
  INBOX_CHANNEL,
  publishInboxEvent,
  type InboxEvent,
} from "./inbox-events.js";

// ---------------- Kontak semu & filter ----------------
// (definisi kanonis di wa-jid.ts — modul ini re-export agar consumer
// lama tidak rusak; client browser memakai @reza-ai/core/client)
export { isPseudoPn, shouldIgnoreChat, type IgnoreInput } from "./wa-jid.js";

// ---------------- Upsert kontak (mapping LID<->PN) ----------------

export interface ContactIdentity {
  /** Nomor E.164 tanpa "+" — atau pn semu (group:/broadcast/lid:). */
  pn: string;
  lid?: string;
}

/**
 * Upsert Contact tanpa duplikat:
 * - Cari by lid dulu, lalu by pn.
 * - Bila pesan membawa keduanya dan menunjuk dua baris berbeda,
 *   menangkan baris pn (tempelkan lid bila kosong).
 * - Placeholder "lid:<lid>" diganti nomor asli begitu diketahui.
 */
async function upsertContact(
  prisma: PrismaClient,
  identity: ContactIdentity,
) {
  const pn = identity.pn;
  const lid = identity.lid || undefined;
  if (!pn && !lid) {
    throw new Error(
      "processInboundMessage: pesan tanpa identitas pengirim (pn & lid kosong).",
    );
  }

  const byLid = lid ? await prisma.contact.findUnique({ where: { lid } }) : null;
  const byPn = pn ? await prisma.contact.findUnique({ where: { pn } }) : null;

  if (byLid && byPn && byLid.id !== byPn.id) {
    if (!byPn.lid && lid) {
      return prisma.contact.update({
        where: { id: byPn.id },
        data: { lid },
      });
    }
    return byPn;
  }

  const primary = byPn ?? byLid;
  if (primary) {
    const data: { lid?: string; pn?: string } = {};
    if (lid && !primary.lid) data.lid = lid;
    if (pn && primary.pn !== pn && primary.pn.startsWith("lid:")) data.pn = pn;
    if (Object.keys(data).length === 0) return primary;
    return prisma.contact.update({ where: { id: primary.id }, data });
  }

  return prisma.contact.create({
    data: { pn: pn || `lid:${lid as string}`, ...(lid ? { lid } : {}) },
  });
}

// ---------------- Proses utama ----------------

export interface IngestDeps {
  prisma: PrismaClient;
  redis: Redis;
  /** Nomor owner dari settings (format bebas 08xx/628xx — dinormalisasi di dalam). */
  getOwnerNumber: () => Promise<string>;
  /** Pengaturan umum (Task 8: jeda manual HP + debounce AI). */
  getGeneralSettings: () => Promise<GeneralSettings>;
}

export interface IngestResult {
  chatId: string;
  contactId: string;
  messageId: string | null;
  ignored: boolean;
  isNewChat: boolean;
  /** True bila waMessageId sudah pernah disimpan — tidak disimpan ulang. */
  deduped: boolean;
  fromMe: boolean;
}

/**
 * Simpan satu pesan masuk: normalisasi identitas -> upsert Contact
 * (mapping LID<->PN) -> upsert Chat -> filter ignored -> dedup
 * waMessageId -> simpan Message -> publish event inbox.
 *
 * Pesan fromMe (source "phone", diketik dari HP) disimpan seperti biasa
 * tetapi TIDAK memicu AI — Task 8 membaca flag source/fromMe ini untuk
 * pause otomatis.
 */
export async function processInboundMessage(
  msg: InboundMessage,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { prisma, redis } = deps;

  const chatJid =
    msg.chatJid ?? (msg.from ? pnToJid(msg.from) : msg.lid ? lidToJid(msg.lid) : "");
  const group = isGroupJid(chatJid);
  const broadcast = isBroadcastJid(chatJid);

  let pn: string;
  let lid: string | undefined;
  if (group) {
    pn = `group:${chatJid.split("@")[0]}`;
  } else if (broadcast) {
    pn = "broadcast";
  } else {
    pn = normalizePn(msg.from);
    lid = msg.lid || undefined;
  }

  const contact = await upsertContact(prisma, { pn, lid });

  let chat = await prisma.chat.findUnique({
    where: { contactId: contact.id },
  });
  let isNewChat = false;
  if (!chat) {
    chat = await prisma.chat.create({ data: { contactId: contact.id } });
    isNewChat = true;
  }

  const ownerPn = normalizePn(await deps.getOwnerNumber());
  const ignored = shouldIgnoreChat({
    pn: contact.pn,
    tag: contact.tag as "Lead" | "Internal",
    ownerPn,
    group,
    broadcast,
  });
  if (chat.ignored !== ignored) {
    chat = await prisma.chat.update({
      where: { id: chat.id },
      data: { ignored },
    });
  }

  const fromMe = msg.fromMe === true;

  // Dedup: waMessageId unik — pesan yang sama tidak disimpan dua kali.
  const existing = await prisma.message.findUnique({
    where: { waMessageId: msg.id },
  });
  if (existing) {
    return {
      chatId: chat.id,
      contactId: contact.id,
      messageId: existing.id,
      ignored,
      isNewChat,
      deduped: true,
      fromMe,
    };
  }

  const source = msg.source ?? (fromMe ? "phone" : "wa");

  let created: { id: string };
  try {
    created = await prisma.message.create({
      data: {
        chatId: chat.id,
        waMessageId: msg.id,
        fromMe,
        body: msg.body ?? null,
        mediaType: msg.mediaType ?? null,
        source,
      },
      select: { id: true },
    });
  } catch (e) {
    // Balapan dedup (dua consumer menyimpan id sama bersamaan).
    if ((e as { code?: string }).code === "P2002") {
      const dup = await prisma.message.findUnique({
        where: { waMessageId: msg.id },
        select: { id: true },
      });
      return {
        chatId: chat.id,
        contactId: contact.id,
        messageId: dup?.id ?? null,
        ignored,
        isNewChat,
        deduped: true,
        fromMe,
      };
    }
    throw e;
  }

  // Sentuh updatedAt agar daftar chat terurut dari yang terbaru.
  await prisma.chat.update({
    where: { id: chat.id },
    data: { updatedAt: new Date() },
  });

  await publishInboxEvent(redis, {
    chatId: chat.id,
    messageId: created.id,
    type: "new-message",
  });

  // Task 8 — wiring AI:
  // - Balasan manual dari HP (fromMe + source "phone"): jeda AI otomatis
  //   selama general.manualPauseHours. AI lanjut sendiri setelah
  //   pausedUntil lewat (dicek konsumen ai-reply).
  // - Pesan masuk biasa (non-ignored, bukan fromMe): geser debounce +
  //   antrekan job ai-reply.
  const general = await deps.getGeneralSettings();
  if (fromMe && source === "phone") {
    const pauseMs = Math.max(0, general.manualPauseHours) * 3600_000;
    await prisma.chat.update({
      where: { id: chat.id },
      data: { aiPaused: true, pausedUntil: new Date(Date.now() + pauseMs) },
    });
    await publishInboxEvent(redis, { chatId: chat.id, type: "chat-updated" });
  } else if (!fromMe && !ignored) {
    await scheduleAiReply(redis, chat.id, general.debounceSec);
  }

  return {
    chatId: chat.id,
    contactId: contact.id,
    messageId: created.id,
    ignored,
    isNewChat,
    deduped: false,
    fromMe,
  };
}

// ---------------- Transport antrean ingest ----------------

/** Nama antrean BullMQ (terdaftar di QUEUE_NAMES). */
export const INGEST_QUEUE = "ingest" as const;

/**
 * Fallback transport: Redis list — pola yang sama dengan wa-command
 * (Task 4). BullMQ butuh skrip Lua asli; di E2E (REDIS_URL=memory://,
 * ioredis-mock) pesan dicatat ke list ini dan dikuras worker via
 * drainIngestFallback(). Di produksi (Redis asli) jalur ini tidak dipakai.
 */
export const INGEST_FALLBACK_KEY = "reza:ingest:fallback";

/**
 * Enqueue pesan masuk ke antrean `ingest` (jobId `inbound-<id>` untuk dedup).
 * Mengembalikan transport yang dipakai — jujur untuk diagnosis.
 */
export async function enqueueIngest(
  redis: Redis,
  msg: InboundMessage,
): Promise<{ transport: "bullmq" | "list"; deduped?: boolean }> {
  if (!isMockRedis()) {
    try {
      const { Queue } = await import("bullmq");
      const queue = new Queue(INGEST_QUEUE, {
        connection: redis,
        prefix: QUEUE_PREFIX,
      });
      try {
        await queue.add(
          "inbound-message",
          { ...msg },
          {
            jobId: `inbound-${msg.id}`,
            removeOnComplete: 1000,
            removeOnFail: 500,
          },
        );
      } finally {
        await queue.close();
      }
      return { transport: "bullmq" };
    } catch (err) {
      const text = (err as Error)?.message ?? "";
      // JobId duplikat = pesan yang sama sudah antre — bukan error.
      if (/already exists|duplicate/i.test(text)) {
        return { transport: "bullmq", deduped: true };
      }
      console.warn(
        "[reza-ai/core] enqueueIngest via BullMQ gagal, pakai list fallback:",
        text,
      );
    }
  }

  await redis.rpush(INGEST_FALLBACK_KEY, JSON.stringify(msg));
  return { transport: "list" };
}

/** Kuras semua pesan tertunda di list fallback (dipakai worker + harness E2E). */
export async function drainIngestFallback(
  redis: Redis,
): Promise<InboundMessage[]> {
  const out: InboundMessage[] = [];
  for (;;) {
    const raw = await redis.lpop(INGEST_FALLBACK_KEY);
    if (!raw) break;
    try {
      out.push(JSON.parse(raw) as InboundMessage);
    } catch {
      // Entri korup: lewati.
    }
  }
  return out;
}

/**
 * Poller fallback untuk antrean ingest. Dipakai worker produksi
 * (jaga-jaga bila BullMQ gagal di tengah jalan) dan harness E2E.
 *
 * List fallback dipakai bersama job ingest knowledge (Task 6):
 * payload `{kind: "knowledge-item", itemId}` diarahkan ke
 * `knowledge.processKnowledgeItem`; sisanya dianggap InboundMessage.
 * Mengembalikan fungsi stop().
 */
export function startIngestFallbackPoller(
  redis: Redis,
  deps: IngestDeps,
  intervalMs = 5000,
  knowledge?: {
    processKnowledgeItem: (itemId: string) => Promise<unknown>;
  },
): () => void {
  const timer = setInterval(() => {
    drainIngestFallback(redis)
      .then((items) => {
        for (const msg of items) {
          const payload = msg as unknown as {
            kind?: unknown;
            itemId?: unknown;
          };
          if (
            payload &&
            payload.kind === "knowledge-item" &&
            typeof payload.itemId === "string"
          ) {
            if (!knowledge) {
              console.error(
                "[ingest] job knowledge-item tanpa handler — dilewati.",
              );
              continue;
            }
            void knowledge
              .processKnowledgeItem(payload.itemId)
              .catch((e) =>
                console.error("[ingest] knowledge gagal:", (e as Error).message),
              );
            continue;
          }
          void processInboundMessage(msg as InboundMessage, deps).catch((e) =>
            console.error("[ingest] proses pesan gagal:", (e as Error).message),
          );
        }
      })
      .catch((e) =>
        console.error("[ingest] drain fallback gagal:", (e as Error).message),
      );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
