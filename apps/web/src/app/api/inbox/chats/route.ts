import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getGeneralSettings } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";
import { chatKind, modeLabel } from "@/lib/inbox";

export const dynamic = "force-dynamic";

/**
 * GET /api/inbox/chats — daftar chat untuk kotak masuk.
 *
 * Query:
 * - filter=unread        : hanya chat yang ada pesan belum dibaca.
 * - includeIgnored=1     : tampilkan juga chat yang disembunyikan
 *                          (grup, status, nomor owner, kontak Internal).
 *   Default: chat ignored disembunyikan.
 *
 * "Belum dibaca" = pesan masuk (fromMe=false) yang datang setelah
 * balasan terakhir kita (heuristik tanpa kolom tambahan).
 * Terproteksi: butuh sesi admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const onlyUnread = url.searchParams.get("filter") === "unread";
  const includeIgnored = url.searchParams.get("includeIgnored") === "1";

  const settings = await getGeneralSettings();
  const chats = await prisma.chat.findMany({
    where: includeIgnored ? {} : { ignored: false },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  const out: Array<Record<string, unknown>> = [];
  for (const c of chats) {
    const lastOwn = await prisma.message.findFirst({
      where: { chatId: c.id, fromMe: true },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const unread = await prisma.message.count({
      where: {
        chatId: c.id,
        fromMe: false,
        ...(lastOwn ? { createdAt: { gt: lastOwn.createdAt } } : {}),
      },
    });
    if (onlyUnread && unread === 0) continue;
    const [pendingDrafts, openHandoff] = await Promise.all([
      prisma.draft.count({
        where: { chatId: c.id, status: "pending" },
      }),
      prisma.handoff.findFirst({
        where: { chatId: c.id, status: "open" },
        select: { id: true },
      }),
    ]);
    const last = c.messages[0];
    out.push({
      id: c.id,
      contact: { pn: c.contact.pn, tag: c.contact.tag, name: c.contact.name },
      kind: chatKind(c.contact.pn),
      mode: c.modeOverride ?? settings.aiMode,
      modeLabel: modeLabel(c.modeOverride ?? settings.aiMode),
      modeOverride: c.modeOverride,
      aiPaused: c.aiPaused,
      pendingDrafts,
      hasOpenHandoff: openHandoff !== null,
      ignored: c.ignored,
      unread,
      lastMessage: last
        ? {
            body: last.body,
            fromMe: last.fromMe,
            mediaType: last.mediaType,
            source: last.source,
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      updatedAt: c.updatedAt.toISOString(),
    });
  }

  return NextResponse.json({ chats: out });
}
