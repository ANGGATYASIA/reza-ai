import type { Job } from "bullmq";
import type Redis from "ioredis";
import {
  BaileysGateway,
  FakeGateway,
  drainWaCommandFallback,
  enqueueIngest,
  publishWaStatus,
  type InboundMessage,
  type WaCommand,
  type WaCommandPayload,
  type WaStatusPayload,
  type WhatsAppGateway,
} from "@reza-ai/core";

export interface WhatsAppManager {
  gateway: WhatsAppGateway;
  /** Prosesor BullMQ untuk queue wa-command. */
  handleCommand(job: Job): Promise<void>;
  /** Eksekusi satu perintah (dipakai handleCommand + poller fallback). */
  handleCommandPayload(payload: WaCommandPayload): Promise<void>;
  /** Poller list fallback (untuk ENV Redis mock/E2E). */
  startFallbackPoller(intervalMs?: number): void;
  close(): Promise<void>;
}

/**
 * Menyalakan koneksi WhatsApp worker:
 * - BaileysGateway connect() saat start (kecuali WA_ENABLED=0).
 *   WA_GATEWAY=fake memakai FakeGateway in-memory (tanpa QR/jaringan)
 *   untuk pengujian jalur worker tanpa akun WhatsApp asli.
 * - Setiap perubahan status dipublish ke Redis channel reza:wa:status
 *   (dibaca dashboard via SSE).
 * - Pesan masuk dinormalisasi lalu di-enqueue ke antrean "ingest"
 *   (BullMQ di Redis asli, list fallback di E2E) dengan jobId
 *   `inbound-<id>` (dedup). Konsumen ingest = processInboundMessage
 *   (Task 5, didaftarkan di index.ts).
 *
 * Pesan fromMe: BaileysGateway sudah menyaring cermin kiriman gateway
 * sendiri (cache ID terkirim 15 menit); yang lolos = pesan dari HP
 * (InboundMessage {fromMe: true, source: "phone"}) -> dicatat ingest,
 * tidak memicu AI (Task 8 membaca flag ini untuk pause).
 */
export async function startWhatsApp(opts: {
  redis: Redis;
}): Promise<WhatsAppManager> {
  const { redis } = opts;
  const useFake = process.env.WA_GATEWAY === "fake";

  let gateway: WhatsAppGateway;
  if (useFake) {
    gateway = new FakeGateway();
    console.log("[whatsapp] WA_GATEWAY=fake — memakai FakeGateway (tanpa QR/jaringan).");
  } else {
    const bg = new BaileysGateway({
      redis,
      verbose: process.env.WA_VERBOSE === "1",
      publish: (p: WaStatusPayload) => {
        void publishWaStatus(redis, p);
      },
    });
    bg.onStatus((p: WaStatusPayload) => {
      console.log(
        `[whatsapp] status: ${p.status}` +
          (p.name || p.phone ? ` (${[p.name, p.phone].filter(Boolean).join(" ")})` : "") +
          (p.reason ? ` [${p.reason}]` : ""),
      );
    });
    gateway = bg;
  }

  gateway.onMessage(async (msg: InboundMessage) => {
    try {
      await enqueueIngest(redis, msg);
    } catch (e) {
      console.error(
        "[whatsapp] gagal enqueue inbound:",
        (e as Error).message,
      );
    }
  });

  if (process.env.WA_ENABLED !== "0") {
    // Non-blocking: retry loop internal menangani kegagalan koneksi.
    gateway
      .connect()
      .catch((e) => console.error("[whatsapp] connect() gagal:", e));
  } else {
    console.log("[whatsapp] WA_ENABLED=0 — koneksi WhatsApp dimatikan.");
  }

  let poller: NodeJS.Timeout | undefined;

  const manager: WhatsAppManager = {
    gateway,

    async handleCommandPayload(payload: WaCommandPayload): Promise<void> {
      const cmd = payload.command as WaCommand;
      console.log(`[whatsapp] perintah: ${cmd} (dari ${payload.by ?? "?"})`);
      if (!(gateway instanceof BaileysGateway)) {
        console.log(`[whatsapp] (fake) perintah ${cmd} diabaikan — bukan sesi Baileys.`);
        return;
      }
      if (cmd === "logout") {
        await gateway.logout();
      } else if (cmd === "restart") {
        await gateway.restart();
      } else {
        console.warn(`[whatsapp] perintah tidak dikenal: ${String(cmd)}`);
      }
    },

    async handleCommand(job: Job): Promise<void> {
      const data = (job.data ?? {}) as Partial<WaCommandPayload>;
      const command = (data.command ?? job.name) as WaCommand;
      await manager.handleCommandPayload({
        command,
        by: String(data.by ?? "queue"),
        ts: Number(data.ts ?? Date.now()),
      });
    },

    startFallbackPoller(intervalMs = 5000): void {
      if (poller) return;
      poller = setInterval(() => {
        drainWaCommandFallback(redis)
          .then((items) => {
            for (const p of items) void manager.handleCommandPayload(p);
          })
          .catch((e) =>
            console.error("[whatsapp] poller fallback gagal:", e),
          );
      }, intervalMs);
      poller.unref?.();
    },

    async close(): Promise<void> {
      if (poller) clearInterval(poller);
      await gateway.disconnect().catch(() => {});
    },
  };

  return manager;
}
