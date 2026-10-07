import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  publishWaStatus,
  type WaStatusPayload,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * Mensimulasikan event status WhatsApp dari worker: publish payload ke
 * Redis channel `reza:wa:status` memakai klien Redis milik PROSES SERVER.
 *
 * Yang disimulasikan JUJUR hanya *payload*-nya (seolah worker Baileys
 * mengirim QR / connect / open). Jalur setelahnya 100% real:
 * Redis pub/sub -> SSE /api/whatsapp/stream -> EventSource browser -> UI.
 *
 * Body: { status, qr?, phone?, name?, reason? }
 */
function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: Partial<WaStatusPayload>;
  try {
    body = (await req.json()) as Partial<WaStatusPayload>;
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }
  if (!body.status) {
    return NextResponse.json(
      { error: "Field status wajib diisi." },
      { status: 400 },
    );
  }

  const redis = getRedis();
  const published = await publishWaStatus(redis, {
    status: body.status,
    qr: body.qr,
    phone: body.phone,
    name: body.name,
    reason: body.reason ?? "e2e-simulation",
  });
  return NextResponse.json({ ok: true, published });
}
