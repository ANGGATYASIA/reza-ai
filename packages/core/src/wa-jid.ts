/**
 * Normalisasi JID WhatsApp.
 *
 * Baileys v7 memakai dua identitas untuk satu akun/nomor:
 * - PN (Phone Number): "6281234567890@s.whatsapp.net"
 * - LID (Linked Identity): "123456789012345@lid" — pengenal internal
 *   yang tidak bisa diterjemahkan ke nomor telepon secara lokal.
 *
 * Aturan mapping:
 * - "@s.whatsapp.net"          -> { pn }            (nomor langsung dipakai)
 * - "@lid"                     -> { pn: "", lid }    (pn diisi Task 5 dari tabel Contact)
 * - "@g.us" / "@broadcast" / lain -> { pn: "" }     (bukan identitas pengguna)
 *
 * Sufiks device (":27") dipangkas: "62812:27@s.whatsapp.net" -> pn "62812".
 */
export interface NormalizedJid {
  /** Nomor E.164 tanpa "+". Kosong bila identitas @lid / grup / broadcast. */
  pn: string;
  /** LID bila server JID adalah @lid. */
  lid?: string;
}

export function normalizeJid(jid: string): NormalizedJid {
  const [userPart = "", server = ""] = jid.split("@");
  // Pangkas sufiks device ":<n>" bila ada.
  const user = userPart.split(":")[0] ?? "";

  if (server === "s.whatsapp.net") {
    return { pn: user.replace(/\D/g, "") };
  }
  if (server === "lid") {
    return { pn: "", lid: user };
  }
  return { pn: "" };
}

/** Bangun JID chat personal dari nomor E.164 tanpa "+". */
export function pnToJid(pn: string): string {
  return `${pn.replace(/\D/g, "")}@s.whatsapp.net`;
}

/** Bangun JID dari LID. */
export function lidToJid(lid: string): string {
  return `${lid}@lid`;
}

/** True bila JID adalah chat grup. */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith("@g.us");
}

/** True bila JID adalah status/broadcast. */
export function isBroadcastJid(jid: string): boolean {
  return jid === "status@broadcast" || jid.endsWith("@broadcast");
}

/**
 * Normalisasi nomor telepon ke format E.164 tanpa "+".
 * - Buang semua non-digit ("+62 813-..." -> "62813...").
 * - Awalan "0" dianggap nomor Indonesia -> "62" ("0813..." -> "62813...").
 * - String kosong / tanpa digit -> "".
 */
export function normalizePn(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return `62${digits.slice(1)}`;
  return digits;
}

/**
 * True bila pn adalah identitas semu (bukan nomor personal):
 * - "group:<id>" : percakapan grup (@g.us) — satu kontak per grup.
 * - "broadcast"  : status/broadcast — satu kontak penampung.
 * - "lid:<lid>"  : pesan via @lid yang nomornya belum diketahui.
 */
export function isPseudoPn(pn: string): boolean {
  return pn === "broadcast" || pn.startsWith("group:") || pn.startsWith("lid:");
}

export interface IgnoreInput {
  /** pn kontak (sudah final: ternormalisasi atau semu). */
  pn: string;
  tag: "Lead" | "Internal";
  /** Nomor owner ternormalisasi ("" bila tidak dikonfigurasi). */
  ownerPn: string;
  group: boolean;
  broadcast: boolean;
}

/**
 * Keputusan filter: chat ditandai ignored=true (tetap disimpan
 * Contact/Chat/Message-nya, tapi disembunyikan dari inbox default).
 * Penyebab: grup, status/broadcast, nomor owner sendiri, kontak Internal.
 */
export function shouldIgnoreChat(input: IgnoreInput): boolean {
  if (input.group || input.broadcast) return true;
  if (input.ownerPn && input.pn === input.ownerPn) return true;
  if (input.tag === "Internal") return true;
  return false;
}
