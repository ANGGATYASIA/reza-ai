import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/drafts — draf AI yang menunggu persetujuan.
 * Query: chatId (opsional, bila kosong -> semua draf pending).
 * Terproteksi: butuh sesi admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId");

  const drafts = await prisma.draft.findMany({
    where: {
      status: "pending",
      ...(chatId ? { chatId } : {}),
    },
    include: { chat: { include: { contact: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    drafts: drafts.map((d) => ({
      id: d.id,
      chatId: d.chatId,
      contact: {
        pn: d.chat.contact.pn,
        name: d.chat.contact.name,
      },
      body: d.body,
      confidence: d.confidence,
      reason: d.reason,
      sourcesUsed: d.sourcesUsed,
      createdAt: d.createdAt.toISOString(),
    })),
  });
}
