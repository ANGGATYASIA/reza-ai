/**
 * @reza-ai/core/client — helper MURNI yang aman di-bundle ke browser.
 *
 * Aturan keras: modul ini (dan semua yang diimpornya) DILARANG memakai
 * API Node (fs, crypto, dsb.), Prisma, ioredis, atau BullMQ — bahkan via
 * dynamic import (webpack tetap mencoba me-resolve-nya untuk bundle
 * client dan build akan gagal).
 *
 * Yang butuh DB/Redis/gateway: import dari "@reza-ai/core" (server only).
 */
export {
  normalizeJid,
  normalizePn,
  pnToJid,
  lidToJid,
  isGroupJid,
  isBroadcastJid,
  isPseudoPn,
  shouldIgnoreChat,
  type IgnoreInput,
  type NormalizedJid,
} from "./wa-jid.js";

/**
 * Template Fact Sheet Proyek untuk form tambah knowledge teks.
 * Murni (tanpa API Node) supaya bisa dipakai komponen browser.
 * Tanda [KURUNG] = placeholder yang diisi manual oleh admin.
 */
export const FACT_SHEET_TEMPLATE = `# [NAMA PROYEK]

## Ringkasan
[Nama Proyek] adalah [jenis properti: perumahan/cluster/apartemen] di [kota/wilayah].
Dikembangkan oleh [nama developer]. Total [jumlah] unit di atas lahan [luas] hektar.

## Tipe Unit
- Tipe 36/60 — 2 kamar tidur, 1 kamar mandi — harga mulai Rp[xxx] juta
- Tipe 45/90 — 3 kamar tidur, 2 kamar mandi — harga mulai Rp[xxx] juta

## Harga & Promo
- Harga mulai Rp[xxx] juta (belum termasuk PPN & biaya KPR).
- Promo: [contoh: gratis biaya AJB & BBN / subsidi DP RpXX juta].
- Skema bayar: tunai keras, tunai bertahap [x] kali, KPR bank [nama bank].

## Fasilitas Kawasan
- [contoh: clubhouse, kolam renang anak & dewasa, taman bermain]
- [contoh: masjid, ruko komersial, one-gate system + CCTV]

## Akses & Lokasi
- [x] menit ke [tol/jalan utama]
- [x] menit ke [stasiun/mall/rumah sakit]

## Cara Beli & Kontak
- Booking fee Rp[x] juta (refundable [ya/tidak]).
- Hubungi WhatsApp [nomor] untuk survei lokasi.
`;
