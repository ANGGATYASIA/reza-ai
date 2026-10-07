# Demo Task 4 — Koneksi WhatsApp via QR

Tanggal: 2026-10-07. Semua bukti di bawah direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + Redis in-memory), bukan mock UI.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 62/62 hijau (9 file; 21 test baru Task 4) |
| Unit test `apps/web` | 41/41 hijau |
| E2E Playwright `whatsapp.spec.ts` (chromium asli) | 9/9 hijau, zero console error/pageerror |
| E2E regresi `auth.spec.ts` | 8/8 hijau |
| Build | core + worker + web (`next build --webpack`) sukses, lint bersih |
| Worker boot | `tsx src/index.ts` dengan `WA_ENABLED=0` — 8 antrian terdaftar, tanpa crash |

## Yang dibangun

- `packages/core/src/gateway-baileys.ts` — `BaileysGateway` (implementasi
  `WhatsAppGateway` dari Task 1): satu socket per proses, guard `isReconnecting`
  anti error 440, backoff eksponensial 2s→60s, `useMultiFileAuthState`,
  `syncFullHistory: false`, `markOnlineOnConnect: false`,
  `connectTimeoutMs: 60000`, `keepAliveIntervalMs: 30000`.
- `packages/core/src/gateway-fake.ts` — `FakeGateway` in-memory untuk
  menguji seluruh logika AI/CRM Task 6+ tanpa akun WhatsApp asli.
- `packages/core/src/wa-status.ts` — channel `reza:wa:status`, key latest,
  flag `reza:wa:restricted` (error 463).
- `packages/core/src/wa-jid.ts` — `normalizeJid` (PN vs LID), `pnToJid`, `isGroupJid`.
- `packages/core/src/wa-command.ts` — transport perintah `logout`/`restart`.
- `apps/worker/src/whatsapp.ts` — konek saat worker start, konsumsi queue
  `wa-command`, pesan masuk -> antrean `ingest` (dedup `inbound-<id>`).
- Web: halaman `/whatsapp` (link dari dashboard), SSE
  `GET /api/whatsapp/stream`, `POST /api/whatsapp/command`, QR dirender
  server jadi gambar (pola yang sama dengan QR TOTP Task 2).

## Cara reproduksi E2E

```bash
# 1. Reset database E2E
cd apps/web && pnpm e2e:reset-db

# 2. Jalankan server production dengan backend E2E (+ flag API test-only)
export DATABASE_URL="pglite://$HOME/workspace/reza-ai/apps/web/data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
export E2E_TEST_API=1
npx next start -p 3100

# 3. Jalankan Playwright (file ini saja, butuh DB fresh)
npx playwright test whatsapp.spec.ts
```

## Skenario E2E (e2e/whatsapp.spec.ts)

1. **Setup + login** — admin dibuat via wizard `/setup` (seperti file spec lain).
2. **Navigasi** — dari dashboard klik "Koneksi WhatsApp" -> `/whatsapp`
   menampilkan "Belum ada kabar dari worker" (belum ada status).
3. **QR** — `POST /api/test/whatsapp/publish {status:"qr", qr:"..."}` ->
   QR ter-render sebagai `<img alt="Kode QR WhatsApp">` (data URL PNG
   dari server), badge "Menunggu dipindai".
4. **Transisi status** — publish `connecting` -> "Menghubungkan…";
   publish `open` + nama + nomor -> "Terhubung: Reza AI (6282114812842)".
5. **Logout** — klik Logout 2x (konfirmasi) -> notice "Perintah logout
   dikirim" -> `GET /api/test/whatsapp/commands` membuktikan perintah
   `logout` tercatat di antrean wa-command.
6. **Auto-refresh** — publish QR baru -> UI kembali menampilkan QR
   tanpa reload.
7. **Restricted** — publish `restricted` -> badge "Dibatasi (463)" + penjelasan.
8. **Proteksi** — `/api/whatsapp/stream` & `/api/whatsapp/command`
   tanpa sesi -> 401.
9. **Zero console error/pageerror.**

## Kejujuran simulasi

- Yang **disimulasikan**: HANYA payload event di `POST /api/test/whatsapp/publish`
  (string QR / status open) — seolah-olah worker Baileys mengirimnya.
- Yang **real**: Redis pub/sub channel, subscribe di route SSE, render QR
  -> data URL di server, EventSource di browser, seluruh render UI,
  dan pencatatan perintah logout ke antrean wa-command.
- Endpoint `/api/test/*` hanya aktif bila `E2E_TEST_API=1`; tanpa flag
  mengembalikan 404.

## Demo nyata untuk reja (langkah scan QR)

> Catatan: saya di sandbox tidak bisa memindai QR — langkah di bawah
> untuk reja, dan saya TIDAK mengklaim sudah memindai.

Prasyarat: worker + web jalan dengan Redis asli
(`REDIS_URL=redis://...`), `WA_AUTH_DIR` menunjuk direktori yang bisa
ditulis (default `/data/wa-auth`, di-mount sebagai volume di compose).

1. Jalankan worker: `pnpm dev:worker` (atau `docker compose up worker`).
   Worker otomatis membuat sesi baru dan menerbitkan QR.
2. Buka `http://<server>/whatsapp`, login sebagai admin.
3. Kode QR tampil dengan status "Menunggu dipindai".
4. Di HP: buka WhatsApp -> **⋮** -> **Perangkat tertaut** ->
   **Tautkan perangkat** -> pindai kode di layar.
5. Status berubah menjadi **"Terhubung: \<nama akun> (\<nomor>)"**.
   QR kedaluwarsa? Kode baru muncul otomatis — pindai yang terbaru.
6. Tombol **Restart koneksi**: memaksa sambung ulang (sesi tetap).
   Tombol **Logout** (klik 2x konfirmasi): menghapus sesi di server,
   lalu QR baru terbit untuk menautkan ulang / ganti nomor.

### Arti tiap status

| Status | Arti |
|---|---|
| Menunggu dipindai | QR aktif — pindai dari HP |
| Menghubungkan… | Mencoba tersambung / mencoba ulang otomatis |
| Terhubung | Sesi aktif; pesan pelanggan mengalir ke kotak masuk (Task 5) |
| Terputus | Koneksi putus; worker mencoba ulang otomatis |
| Dibatasi (463) | WhatsApp membatasi akun — pengiriman ditahan otomatis |

### Error 463 (akun dibatasi)

Bila WhatsApp menutup koneksi dengan kode 463, worker:
menyetel flag Redis `reza:wa:restricted=1` (TTL 24 jam),
mempublish status `restricted` (dashboard menampilkan banner),
dan TIDAK auto-reconnect. `send()`/`sendMedia()` menolak pengiriman
selama flag aktif. Perintah **Restart** membersihkan flag lalu mencoba
sambung ulang. Task 11 membaca flag ini untuk auto-pause.

### Lokasi auth

State sesi Baileys tersimpan di direktori `WA_AUTH_DIR`
(default `/data/wa-auth`; lihat `.env.example`). Jangan commit isinya.
Perintah logout / event loggedOut dari HP menghapus SELURUH isi
direktori ini lalu menerbitkan QR baru.

## Batasan yang diakui jujur

- E2E memakai **Redis in-memory** (`REDIS_URL=memory://`, ioredis-mock):
  BullMQ butuh skrip Lua asli sehingga perintah wa-command lewat
  **Redis list fallback** (`reza:wa:command:fallback`), bukan BullMQ.
  Di produksi (Redis asli) perintah lewat BullMQ `wa-command`; worker
  mengonsumsi keduanya (BullMQ Worker + poller fallback 5 detik).
- Scan QR asli belum dilakukan (butuh HP reja) — alurnya didokumentasikan
  di atas; yang terbukti E2E adalah seluruh jalur status & perintah.
- Bila akun reja memakai identitas `@lid` (Baileys v7), kolom nomor di
  status "Terhubung" bisa kosong — hanya nama yang tampil. Mapping
  LID<->PN dibangun di Task 5 via tabel Contact.
