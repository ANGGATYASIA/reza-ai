import QRCode from "qrcode";
import type { NextRequest } from "next/server";
import {
  createRedisClient,
  getLatestWaStatus,
  WA_STATUS_CHANNEL,
  type WaConnectionStatus,
  type WaStatusPayload,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Event yang dikirim ke browser. QR mentah TIDAK dikirim —
 * server me-render jadi data URL gambar (pola yang sama dengan QR TOTP Task 2).
 */
export interface WhatsAppStreamEvent {
  status: WaConnectionStatus | "unknown";
  qrDataUrl?: string;
  phone?: string;
  name?: string;
  reason?: string;
  ts: number;
}

async function toStreamEvent(raw: WaStatusPayload): Promise<WhatsAppStreamEvent> {
  const ev: WhatsAppStreamEvent = {
    status: raw.status,
    phone: raw.phone,
    name: raw.name,
    reason: raw.reason,
    ts: raw.ts ?? Date.now(),
  };
  if (raw.status === "qr" && raw.qr) {
    ev.qrDataUrl = await QRCode.toDataURL(raw.qr, { width: 248, margin: 1 });
  }
  return ev;
}

/**
 * GET /api/whatsapp/stream — Server-Sent Events status koneksi WhatsApp.
 *
 * Alur REAL (bukan mock): subscribe Redis channel `reza:wa:status` yang
 * ditulis worker (BaileysGateway). Saat klien baru tersambung, status
 * terakhir dikirim dulu dari key `reza:wa:status:latest`.
 * Terproteksi: butuh sesi admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  // Klien subscriber khusus (koneksi Redis dalam mode subscribe).
  const subscriber = createRedisClient();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const pushPayload = async (raw: WaStatusPayload) => {
        try {
          const ev = await toStreamEvent(raw);
          send(`data: ${JSON.stringify(ev)}\n\n`);
        } catch {
          // QR gagal di-render / klien pergi: abaikan event ini.
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        subscriber.disconnect();
        try {
          controller.close();
        } catch {
          // sudah ditutup
        }
      };

      // 1. Status terakhir dulu (bila worker pernah publish);
      // bila belum ada, kirim "unknown" agar UI tidak stuck di loading.
      try {
        const latest = await getLatestWaStatus(subscriber);
        if (latest) {
          await pushPayload(latest);
        } else {
          send(
            `data: ${JSON.stringify({ status: "unknown", ts: Date.now() })}\n\n`,
          );
        }
      } catch {
        // Redis belum siap: lanjut ke subscribe.
      }

      // 2. Subscribe update berikutnya.
      try {
        await subscriber.subscribe(WA_STATUS_CHANNEL);
      } catch {
        send(`data: ${JSON.stringify({ status: "unknown", ts: Date.now(), reason: "subscribe-gagal" })}\n\n`);
        cleanup();
        return;
      }
      subscriber.on("message", (_channel, message) => {
        try {
          const raw = JSON.parse(String(message)) as WaStatusPayload;
          void pushPayload(raw);
        } catch {
          // payload korup: abaikan
        }
      });

      // 3. Ping agar koneksi tidak diputus proxy diam-diam.
      const ping = setInterval(() => send(": ping\n\n"), 25_000);

      req.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      closed = true;
      try {
        subscriber.disconnect();
      } catch {
        // abaikan
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
