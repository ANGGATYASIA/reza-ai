import type Redis from "ioredis";

/** Channel pub/sub Redis untuk event status koneksi WhatsApp (worker -> web). */
export const WA_STATUS_CHANNEL = "reza:wa:status";

/** Key berisi payload status TERAKHIR (SET EX 1 jam); dibaca SSE saat klien baru tersambung. */
export const WA_STATUS_LATEST_KEY = "reza:wa:status:latest";

/**
 * Flag akun dibatasi WhatsApp (error 463). Nilai "1" bila dibatasi.
 * Follow-up Task 11 membaca flag ini untuk auto-pause pengiriman.
 */
export const WA_RESTRICTED_KEY = "reza:wa:restricted";

/** Status koneksi yang dipublish worker dan dirender dashboard. */
export type WaConnectionStatus =
  | "qr" // QR tampil — menunggu dipindai dari HP
  | "connecting" // mencoba tersambung / mencoba ulang
  | "open" // terhubung — sesi aktif
  | "close" // koneksi ditutup (manual / gagal)
  | "restricted"; // akun dibatasi WhatsApp (error 463)

/** Payload event di channel reza:wa:status. */
export interface WaStatusPayload {
  status: WaConnectionStatus;
  /** String QR mentah dari Baileys (hanya saat status "qr"). Web me-render jadi gambar. */
  qr?: string;
  /** Nomor akun sendiri, E.164 tanpa "+" (hanya saat "open"; kosong bila identitas @lid). */
  phone?: string;
  /** Nama akun WhatsApp (hanya saat "open"). */
  name?: string;
  /** Alasan tambahan: "logged-out" | "logout" | "restart" | "manual" | "463" | kode error. */
  reason?: string;
  /** Waktu event (ms epoch). Diisi otomatis bila tidak diberikan. */
  ts?: number;
}

/**
 * Publish event status ke channel + simpan sebagai status terakhir.
 * Satu-satunya penulis status adalah worker (BaileysGateway).
 */
export async function publishWaStatus(
  redis: Redis,
  payload: WaStatusPayload,
): Promise<WaStatusPayload> {
  const full: WaStatusPayload = { ...payload, ts: payload.ts ?? Date.now() };
  const raw = JSON.stringify(full);
  // EX 3600: status basi hilang sendiri bila worker mati lama.
  await redis.set(WA_STATUS_LATEST_KEY, raw, "EX", 3600);
  await redis.publish(WA_STATUS_CHANNEL, raw);
  return full;
}

/** Baca status terakhir (untuk SSE handshake / diagnosis). */
export async function getLatestWaStatus(
  redis: Redis,
): Promise<WaStatusPayload | null> {
  const raw = await redis.get(WA_STATUS_LATEST_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaStatusPayload;
  } catch {
    return null;
  }
}

/** Tandai / hapus tanda pembatasan akun (error 463). TTL 24 jam. */
export async function setWaRestricted(
  redis: Redis,
  restricted: boolean,
): Promise<void> {
  if (restricted) {
    await redis.set(WA_RESTRICTED_KEY, "1", "EX", 24 * 3600);
  } else {
    await redis.del(WA_RESTRICTED_KEY);
  }
}

/**
 * Cek apakah akun WhatsApp sedang dibatasi (error 463).
 * Dipakai Task 11 untuk auto-pause; dashboard membaca untuk banner.
 */
export async function isRestricted(redis: Redis): Promise<boolean> {
  return (await redis.get(WA_RESTRICTED_KEY)) === "1";
}
