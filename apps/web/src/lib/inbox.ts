import { isPseudoPn, normalizePn } from "@reza-ai/core/client";

/**
 * Helper presentasi inbox (dipakai API route + komponen + unit test).
 */

export type ChatKind = "personal" | "group" | "broadcast";

export function chatKind(pn: string): ChatKind {
  if (pn === "broadcast") return "broadcast";
  if (pn.startsWith("group:")) return "group";
  return "personal";
}

/** Nama tampil kontak: nama bila ada, else nomor terformat / label semu. */
export function displayName(pn: string, name?: string | null): string {
  if (name) return name;
  const kind = chatKind(pn);
  if (kind === "group") return "Grup WhatsApp";
  if (kind === "broadcast") return "Status WA";
  return formatPn(pn);
}

/** 628131742034 -> "+62 813-1742-034". Nomor pendek dikembalikan apa adanya. */
export function formatPn(pn: string): string {
  const d = normalizePn(pn);
  if (d.startsWith("62") && d.length >= 11) {
    const rest = d.slice(2);
    return `+62 ${rest.slice(0, 3)}-${rest.slice(3, 7)}-${rest.slice(7)}`;
  }
  return pn;
}

export type ModeLabel = "Full" | "Semi" | "Nonaktif";

/** modeOverride chat atau mode global AI -> label badge. */
export function modeLabel(mode: string | null | undefined): ModeLabel {
  if (mode === "semi") return "Semi";
  if (mode === "off") return "Nonaktif";
  return "Full";
}

/**
 * Parse textarea impor nomor: pisahkan baris/koma/titik koma, normalisasi
 * tiap entri (08xx, 628xx, +62 -> bentuk 62xx yang sama), buang duplikat
 * & entri kosong. Entri tak dikenali / kontak semu dilaporkan sebagai gagal.
 */
export interface ParsedImport {
  numbers: string[];
  failed: string[];
}

export function parseImportNumbers(input: string): ParsedImport {
  const numbers: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();
  for (const part of input.split(/[\n,;]+/)) {
    const raw = part.trim();
    if (!raw) continue;
    if (isPseudoPn(raw) || /^[a-z]+:/i.test(raw)) {
      failed.push(raw);
      continue;
    }
    const norm = normalizePn(raw);
    if (!norm) {
      failed.push(raw);
      continue;
    }
    if (!seen.has(norm)) {
      seen.add(norm);
      numbers.push(norm);
    }
  }
  return { numbers, failed };
}

/** Format waktu ala chat: "14:32" (hari ini) / "Kemarin" / "7 Okt". */
export function formatChatTime(iso: string | Date): string {
  const d = new Date(iso);
  const now = new Date();
  const tz = "Asia/Jakarta";
  const day = (x: Date) =>
    new Intl.DateTimeFormat("id-ID", { timeZone: tz, dateStyle: "short" }).format(x);
  const time = new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  if (day(d) === day(now)) return time;
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
  if (day(d) === day(yesterday)) return `Kemarin ${time}`;
  const date = new Intl.DateTimeFormat("id-ID", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  }).format(d);
  return `${date} ${time}`;
}
