import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getGeneralSettings,
  isPseudoPn,
  normalizePn,
  shouldIgnoreChat,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

const VALID_TAGS = ["Lead", "Internal"] as const;

/**
 * POST /api/inbox/contacts/tag — ubah tag kontak.
 * Body: { "pn": "0813...", "tag": "Lead" | "Internal" }.
 *
 * Menandai Internal otomatis menyembunyikan chat dari inbox default
 * (ignored=true); mengembalikan ke Lead membuka sembunyinya lagi
 * (kecuali chat memang grup/status/nomor owner).
 * Terproteksi: butuh sesi admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { pn?: unknown; tag?: unknown };
  try {
    body = (await req.json()) as { pn?: unknown; tag?: unknown };
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }

  const rawPn = typeof body.pn === "string" ? body.pn : "";
  const tag = typeof body.tag === "string" ? body.tag : "";
  if (!VALID_TAGS.includes(tag as (typeof VALID_TAGS)[number])) {
    return NextResponse.json(
      { error: "Tag tidak dikenal. Pilihan: Lead, Internal." },
      { status: 400 },
    );
  }
  if (isPseudoPn(rawPn) || /^[a-z]+:/i.test(rawPn)) {
    return NextResponse.json(
      { error: "Kontak ini bukan nomor personal — tag tidak bisa diubah." },
      { status: 400 },
    );
  }
  const pn = normalizePn(rawPn);
  if (!pn) {
    return NextResponse.json(
      { error: "Nomor tidak dikenali. Contoh: 08131742034." },
      { status: 400 },
    );
  }

  const contact = await prisma.contact.upsert({
    where: { pn },
    create: { pn, tag: tag as "Lead" },
    update: { tag: tag as "Lead" },
  });

  // Hitung ulang flag ignored (grup/status/nomor owner ikut dipertimbangkan).
  const settings = await getGeneralSettings();
  const ownerPn = normalizePn(settings.ownerWaNumber);
  const chat = await prisma.chat.findUnique({
    where: { contactId: contact.id },
  });
  let ignored = false;
  if (chat) {
    ignored = shouldIgnoreChat({
      pn: contact.pn,
      tag: contact.tag as "Lead" | "Internal",
      ownerPn,
      group: false,
      broadcast: false,
    });
    if (chat.ignored !== ignored) {
      await prisma.chat.update({ where: { id: chat.id }, data: { ignored } });
    }
  }

  return NextResponse.json({
    ok: true,
    contact: { pn: contact.pn, tag: contact.tag },
    chatId: chat?.id ?? null,
    ignored,
  });
}
