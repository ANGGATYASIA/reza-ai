import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { enqueueSend } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/drafts/[id]/approve — setujui draf AI (Task 8).
 * Body opsional: { body } = teks yang diedit — bila berbeda dari draf
 * asli, status dicatat "edited", lalu dikirim via enqueueSend source "ai".
 * Terproteksi: butuh sesi admin.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const draft = await prisma.draft.findUnique({ where: { id } });
  if (!draft) {
    return NextResponse.json({ error: "Draf tidak ditemukan." }, { status: 404 });
  }
  if (draft.status !== "pending") {
    return NextResponse.json(
      { error: `Draf sudah ${draft.status} — tidak bisa disetujui ulang.` },
      { status: 409 },
    );
  }

  let body: { body?: unknown } = {};
  try {
    body = (await req.json()) as { body?: unknown };
  } catch {
    // Body kosong = setujui apa adanya.
  }

  const edited =
    typeof body.body === "string" && body.body.trim().length > 0
      ? body.body.trim()
      : draft.body;
  const wasEdited = edited !== draft.body;

  const updated = await prisma.draft.update({
    where: { id },
    data: {
      body: edited,
      status: wasEdited ? "edited" : "approved",
    },
    select: { id: true, chatId: true, body: true, status: true },
  });

  // Kirim seperti balasan AI biasa (masuk antrean + limiter global).
  const { transport } = await enqueueSend(
    getRedis(),
    updated.chatId,
    { text: updated.body },
    "ai",
  );

  return NextResponse.json({
    ok: true,
    draft: { id: updated.id, status: updated.status },
    transport,
  });
}
