import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";
import { chatKind, modeLabel } from "@/lib/inbox";
import { getGeneralSettings, publishInboxEvent } from "@reza-ai/core";

export const dynamic = "force-dynamic";

const MODE_OVERRIDES = [null, "full", "semi", "off"] as const;

/**
 * GET /api/inbox/chats/[id] — thread satu chat: info kontak + daftar pesan.
 * Task 8: ikut sertakan aiPaused, modeOverride, draf pending, handoff open.
 * Terproteksi: butuh sesi admin.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const chat = await prisma.chat.findUnique({
    where: { id },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: "asc" }, take: 500 },
      drafts: {
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      handoffs: {
        where: { status: "open" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  if (!chat) {
    return NextResponse.json(
      { error: "Chat tidak ditemukan." },
      { status: 404 },
    );
  }

  const settings = await getGeneralSettings();
  const openHandoff = chat.handoffs[0] ?? null;
  return NextResponse.json({
    chat: {
      id: chat.id,
      contact: {
        pn: chat.contact.pn,
        tag: chat.contact.tag,
        name: chat.contact.name,
      },
      kind: chatKind(chat.contact.pn),
      mode: chat.modeOverride ?? settings.aiMode,
      modeLabel: modeLabel(chat.modeOverride ?? settings.aiMode),
      modeOverride: chat.modeOverride,
      aiPaused: chat.aiPaused,
      pausedUntil: chat.pausedUntil ? chat.pausedUntil.toISOString() : null,
      ignored: chat.ignored,
      openHandoff: openHandoff
        ? {
            id: openHandoff.id,
            reason: openHandoff.reason,
            summary: openHandoff.summary,
            createdAt: openHandoff.createdAt.toISOString(),
          }
        : null,
    },
    pendingDrafts: chat.drafts.map((d) => ({
      id: d.id,
      body: d.body,
      confidence: d.confidence,
      reason: d.reason,
      sourcesUsed: d.sourcesUsed,
      createdAt: d.createdAt.toISOString(),
    })),
    messages: chat.messages.map((m) => ({
      id: m.id,
      fromMe: m.fromMe,
      body: m.body,
      mediaType: m.mediaType,
      source: m.source,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

/**
 * PATCH /api/inbox/chats/[id] — ubah override mode AI per chat (Task 8).
 * Body: { modeOverride: "full" | "semi" | "off" | null }.
 * null = Auto (ikut mode global).
 * Terproteksi: butuh sesi admin.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const { id } = await params;
  let body: { modeOverride?: unknown };
  try {
    body = (await req.json()) as { modeOverride?: unknown };
  } catch {
    return NextResponse.json(
      { error: "Body harus JSON yang valid." },
      { status: 400 },
    );
  }

  const modeOverride = body.modeOverride ?? null;
  if (!(MODE_OVERRIDES as readonly unknown[]).includes(modeOverride)) {
    return NextResponse.json(
      { error: "modeOverride harus full, semi, off, atau null (Auto)." },
      { status: 400 },
    );
  }

  const chat = await prisma.chat.findUnique({ where: { id } });
  if (!chat) {
    return NextResponse.json(
      { error: "Chat tidak ditemukan." },
      { status: 404 },
    );
  }

  const updated = await prisma.chat.update({
    where: { id },
    data: { modeOverride: modeOverride as "full" | "semi" | "off" | null },
    select: { id: true, modeOverride: true },
  });

  await publishInboxEvent(getRedis(), { chatId: id, type: "chat-updated" });

  return NextResponse.json({
    ok: true,
    chat: { id: updated.id, modeOverride: updated.modeOverride },
  });
}
