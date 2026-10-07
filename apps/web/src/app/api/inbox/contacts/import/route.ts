import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getGeneralSettings,
  normalizePn,
  shouldIgnoreChat,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";
import { parseImportNumbers } from "@/lib/inbox";

export const dynamic = "force-dynamic";

/**
 * POST /api/inbox/contacts/import — impor daftar nomor sebagai Internal.
 * Body: { "numbers": "0812...\n62812..., +62813..." }.
 *
 * Tiap nomor dinormalisasi (08xx / 628xx / +62 -> bentuk 62xx yang sama),
 * duplikat dibuang, lalu kontak ditandai Internal (chat-nya otomatis
 * disembunyikan dari inbox default). Response jujur: berapa berhasil,
 * berapa gagal, dan entri mana yang gagal.
 * Terproteksi: butuh sesi admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { numbers?: unknown };
  try {
    body = (await req.json()) as { numbers?: unknown };
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }
  const input = typeof body.numbers === "string" ? body.numbers : "";
  if (!input.trim()) {
    return NextResponse.json(
      { error: "Daftar nomor masih kosong — tempel dulu nomornya." },
      { status: 400 },
    );
  }

  const { numbers, failed } = parseImportNumbers(input);
  const settings = await getGeneralSettings();
  const ownerPn = normalizePn(settings.ownerWaNumber);

  let imported = 0;
  for (const pn of numbers) {
    const contact = await prisma.contact.upsert({
      where: { pn },
      create: { pn, tag: "Internal" },
      update: { tag: "Internal" },
    });
    const chat = await prisma.chat.findUnique({
      where: { contactId: contact.id },
    });
    if (chat) {
      const ignored = shouldIgnoreChat({
        pn: contact.pn,
        tag: "Internal",
        ownerPn,
        group: false,
        broadcast: false,
      });
      if (chat.ignored !== ignored) {
        await prisma.chat.update({ where: { id: chat.id }, data: { ignored } });
      }
    }
    imported += 1;
  }

  return NextResponse.json({
    ok: true,
    imported,
    failed,
    total: numbers.length + failed.length,
  });
}
