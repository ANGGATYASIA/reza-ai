import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { enqueueSend, isPseudoPn } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

const MAX_TEXT = 4000;

/**
 * POST /api/inbox/send — kirim pesan manual dari kotak masuk.
 * Body: { "chatId": "...", "text": "..." }.
 *
 * Pesan TIDAK dikirim langsung: masuk antrean `send` (BullMQ di produksi,
 * list fallback di E2E) lalu worker mengeksekusinya lewat gateway dengan
 * limiter global 20 pesan/menit. Response mengembalikan transport yang
 * dipakai. Terproteksi: butuh sesi admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { chatId?: unknown; text?: unknown };
  try {
    body = (await req.json()) as { chatId?: unknown; text?: unknown };
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }

  const chatId = typeof body.chatId === "string" ? body.chatId : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!chatId) {
    return NextResponse.json(
      { error: "chatId wajib diisi." },
      { status: 400 },
    );
  }
  if (!text) {
    return NextResponse.json(
      { error: "Pesan masih kosong — tulis dulu pesannya." },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT) {
    return NextResponse.json(
      { error: `Pesan terlalu panjang (maks ${MAX_TEXT} karakter).` },
      { status: 400 },
    );
  }

  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    include: { contact: true },
  });
  if (!chat) {
    return NextResponse.json(
      { error: "Chat tidak ditemukan." },
      { status: 404 },
    );
  }
  if (isPseudoPn(chat.contact.pn)) {
    return NextResponse.json(
      { error: "Chat ini bukan nomor personal — tidak bisa dikirimi pesan." },
      { status: 400 },
    );
  }

  try {
    const { transport } = await enqueueSend(
      getRedis(),
      chatId,
      { text },
      "dashboard",
      auth.admin.email,
    );
    return NextResponse.json({ ok: true, transport });
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal mengantrekan pesan: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
