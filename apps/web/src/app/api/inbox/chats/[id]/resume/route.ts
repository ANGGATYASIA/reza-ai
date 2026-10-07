import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { publishInboxEvent } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/chats/[id]/resume — lanjutkan AI setelah handoff/jeda.
 * aiPaused=false, pausedUntil=null, handoff yang masih open -> "resumed".
 * Terproteksi: butuh sesi admin.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const chat = await prisma.chat.findUnique({ where: { id } });
  if (!chat) {
    return NextResponse.json(
      { error: "Chat tidak ditemukan." },
      { status: 404 },
    );
  }

  await prisma.chat.update({
    where: { id },
    data: { aiPaused: false, pausedUntil: null },
  });
  const resumed = await prisma.handoff.updateMany({
    where: { chatId: id, status: "open" },
    data: { status: "resumed" },
  });

  await publishInboxEvent(getRedis(), { chatId: id, type: "chat-updated" });

  return NextResponse.json({
    ok: true,
    aiPaused: false,
    handoffsResumed: resumed.count,
  });
}
