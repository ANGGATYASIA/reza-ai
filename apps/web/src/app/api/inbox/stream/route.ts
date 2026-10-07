import type { NextRequest } from "next/server";
import { createRedisClient, INBOX_CHANNEL } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/inbox/stream — Server-Sent Events untuk kotak masuk realtime.
 *
 * Subscribe Redis channel `reza:inbox` yang ditulis processInboundMessage /
 * processSendJob setiap ada pesan baru. Browser me-refresh daftar chat &
 * thread aktif saat event tiba — tanpa reload halaman.
 * Terproteksi: butuh sesi admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

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

      try {
        await subscriber.subscribe(INBOX_CHANNEL);
      } catch {
        send(
          `data: ${JSON.stringify({ type: "error", reason: "subscribe-gagal", ts: Date.now() })}\n\n`,
        );
        cleanup();
        return;
      }
      subscriber.on("message", (_channel, message) => {
        // Teruskan apa adanya: { chatId, messageId, type, ts }.
        send(`data: ${message}\n\n`);
      });

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
