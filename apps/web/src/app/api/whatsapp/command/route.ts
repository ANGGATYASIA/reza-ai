import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createRedisClient, enqueueWaCommand, type WaCommand } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

const VALID_COMMANDS: WaCommand[] = ["logout", "restart"];

/**
 * POST /api/whatsapp/command — kirim perintah ke worker WhatsApp.
 * Body: { "command": "logout" | "restart" }
 *
 * - logout:  hapus sesi auth + putuskan koneksi; QR baru terbit.
 * - restart: paksa reconnect (socket lama ditutup dulu).
 *
 * Transport: antrean BullMQ `wa-command` di Redis asli; di E2E
 * (Redis in-memory) perintah dicatat ke Redis list fallback karena
 * BullMQ butuh skrip Lua asli (lihat enqueueWaCommand).
 * Terproteksi: butuh sesi admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { command?: unknown };
  try {
    body = (await req.json()) as { command?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Body harus JSON: { \"command\": \"logout\" | \"restart\" }." },
      { status: 400 },
    );
  }

  const command = body.command as WaCommand;
  if (!VALID_COMMANDS.includes(command)) {
    return NextResponse.json(
      { error: "Perintah tidak dikenal. Pilihan: logout, restart." },
      { status: 400 },
    );
  }

  const redis = createRedisClient();
  try {
    const { payload, transport } = await enqueueWaCommand(
      redis,
      command,
      auth.admin.email,
    );
    return NextResponse.json({ ok: true, command, ts: payload.ts, transport });
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal mengirim perintah: ${(e as Error).message}` },
      { status: 500 },
    );
  } finally {
    redis.disconnect();
  }
}
