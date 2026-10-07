/** Zona waktu operasional Reza AI. */
export const WIB_TIMEZONE = "Asia/Jakarta";

/** Jam mulai quiet hours (default 20 = 20.00 WIB). */
export const QUIET_HOURS_START = 20;
/** Jam selesai quiet hours (default 8 = 08.00 WIB). */
export const QUIET_HOURS_END = 8;

/** Waktu sekarang sebagai Date (tetap UTC di dalam; format pakai WIB). */
export function nowWIB(): Date {
  return new Date();
}

function hourInWIB(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WIB_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  // Beberapa implementasi mengembalikan "24" untuk tengah malam.
  return hour % 24;
}

/**
 * Apakah `date` masuk jam sunyi (tidak boleh kirim pesan proaktif).
 * Default: 20.00–08.00 WIB. Mendukung rentang yang melewati tengah malam.
 */
export function isQuietHours(
  date: Date,
  startH: number = QUIET_HOURS_START,
  endH: number = QUIET_HOURS_END,
): boolean {
  const h = hourInWIB(date);
  if (startH <= endH) return h >= startH && h < endH;
  return h >= startH || h < endH;
}

const MONTHS_ID = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
];

/**
 * Format tanggal-waktu Indonesia, mis. "6 Okt 2026, 23:15 WIB".
 */
export function formatWIB(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: WIB_TIMEZONE,
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = String(Number(get("day"))); // "06" -> "6"
  const month = MONTHS_ID[Number(get("month")) - 1] ?? "";
  const year = get("year");
  const time = `${get("hour")}:${get("minute")}`;
  return `${day} ${month} ${year}, ${time} WIB`;
}
