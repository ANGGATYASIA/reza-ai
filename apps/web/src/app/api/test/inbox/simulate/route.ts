import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { InboundMessage } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { getInboxHarness } from "@/lib/inbox-harness";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * Mensimulasikan pesan WhatsApp masuk lewat FakeGateway harness:
 * POST /api/test/inbox/simulate { id, from, body, ... } ->
 * gateway.simulateIncoming() -> onMessage -> enqueueIngest ->
 * processInboundMessage (REAL) -> DB + event SSE.
 *
 * Yang disimulasikan JUJUR hanya *pesan*-nya (seolah dikirim pelanggan
 * via WhatsApp). Seluruh jalur setelahnya 100% kode produksi.
 */
export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const harness = getInboxHarness();
  if (!harness) {
    return NextResponse.json(
      { error: "Harness belum jalan — POST /api/test/inbox/harness dulu." },
      { status: 400 },
    );
  }

  let body: Partial<InboundMessage>;
  try {
    body = (await req.json()) as Partial<InboundMessage>;
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json(
      { error: "Field id wajib diisi." },
      { status: 400 },
    );
  }

  const msg: InboundMessage = {
    id: String(body.id),
    from: String(body.from ?? ""),
    lid: body.lid,
    body: body.body,
    mediaType: body.mediaType,
    quotedId: body.quotedId,
    timestamp: Number(body.timestamp ?? Date.now()),
    fromMe: body.fromMe === true,
    source: body.source ?? (body.fromMe === true ? "phone" : "wa"),
    chatJid: body.chatJid,
  };
  await harness.gateway.simulateIncoming(msg);
  return NextResponse.json({ ok: true, id: msg.id });
}
