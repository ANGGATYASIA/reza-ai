# Demo Task 5 — Ingest pesan + Inbox realtime + kirim manual

Tanggal: 2026-10-07. Semua bukti direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + Redis in-memory), bukan mock UI.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 86/86 hijau (11 file; 33 test baru Task 5) |
| Unit test `apps/web` | 50/50 hijau (5 file; 9 test baru Task 5) |
| E2E Playwright `inbox.spec.ts` (chromium asli) | 9/9 hijau, zero console error/pageerror |
| E2E regresi `auth.spec.ts` | 4/4 hijau |
| E2E regresi `whatsapp.spec.ts` (Task 4) | 9/9 hijau |
| Build | core + worker + web (`next build --webpack`) sukses, lint bersih |
| Worker boot | `tsx src/index.ts` dengan `WA_GATEWAY=fake WA_ENABLED=0` — 8 antrian terdaftar, tanpa crash |

## Yang dibangun

**Core (`packages/core/src/`):**
- `ingest.ts` — `processInboundMessage(msg, {prisma, redis, getOwnerNumber})`:
  normalisasi JID -> pn/lid; upsert Contact (mapping LID<->PN tanpa duplikat,
  placeholder `lid:<lid>` diganti nomor asli begitu diketahui); filter ->
  `Chat.ignored=true` untuk grup, status/broadcast, nomor owner
  (08xx/628xx/+62 dinormalisasi dulu), dan kontak tag Internal — Contact/
  Chat/Message tetap disimpan; dedup via `waMessageId` (termasuk tangani
  balapan P2002); pesan fromMe dari HP disimpan `source="phone"`;
  `Chat.updatedAt` disentuh agar daftar terurut; publish event ke channel
  `reza:inbox`. Plus `enqueueIngest`/`drainIngestFallback`/
  `startIngestFallbackPoller` (pola list fallback Task 4 untuk E2E).
- `send-queue.ts` — `enqueueSend(chatId, content, source)`; `processSendJob`:
  validasi chat -> limiter global fixed-window 20 pesan/menit
  (`reza:send:limit:<menit>`, yang ke-21 melempar `SendRateLimitedError`
  berisi `retryAfterMs`) -> `gateway.send()/sendMedia()` -> simpan
  `Message {fromMe: true, source: "dashboard"|"ai"}` -> publish event inbox.
  Worker BullMQ menjadwalkan ulang job yang kena limiter dengan `delay`;
  poller fallback memakai key `reza:send:paused-until`.
- `wa-jid.ts` — `normalizePn` (08xx/628xx/+62/spasi-strip -> 62xx),
  `isBroadcastJid`, `isPseudoPn`, `shouldIgnoreChat`.
- `gateway.ts` — `InboundMessage` dapat field `fromMe?`, `source?`
  (`"wa"|"phone"`), `chatJid?`.
- `gateway-baileys.ts` — cache ID terkirim 15 menit: pesan fromMe yang
  id-nya ada di cache = cermin kiriman gateway sendiri -> dilewati;
  fromMe lain -> `InboundMessage {fromMe: true, source: "phone"}`.
  Grup & status/broadcast TIDAK lagi dibuang di normalisasi — diteruskan
  ke ingest yang menandainya ignored (tetap tersimpan).
- `gateway-fake.ts` — cache yang sama + `wasRecentlySent(id, withinMs)`;
  ID pesan kini unik per instance (`fake-msg-<n>-<rand>`) agar tidak
  tabrakan antar skenario test dalam satu DB.
- `client.ts` (baru, export `@reza-ai/core/client`) — helper murni yang
  aman di-bundle ke browser (aturan keras: tanpa API Node/Prisma/ioredis/
  BullMQ). Dibutuhkan karena `next build` gagal bila komponen client
  mengimpor `@reza-ai/core` penuh (dynamic `import("bullmq")` ikut
  ter-bundle -> `Can't resolve 'fs'`).

**Worker (`apps/worker/src/`):**
- `whatsapp.ts` — `WA_GATEWAY=fake` memakai FakeGateway (tanpa QR/jaringan);
  `onMessage` -> `enqueueIngest` (core, otomatis fallback di mock).
- `index.ts` — consumer BullMQ `ingest` -> `processInboundMessage`,
  `send` -> `processSendJob` (kena limiter -> jadwal ulang dengan delay,
  bukan retry membabi buta); poller fallback ingest + send aktif.

**Web (`apps/web/`):**
- Halaman `/inbox` (link dari dashboard, proteksi `requireAdminPage`):
  daftar chat (kiri) + thread (kanan), badge mode (Full/Semi/Nonaktif dari
  `modeOverride` atau `aiMode` global) + badge tag (Lead/Internal),
  filter Semua / Belum dibaca / Disembunyikan, tombol Tandai Internal,
  panel impor nomor Internal (textarea, lapor berhasil/gagal),
  auto-scroll, pesan baru muncul realtime via SSE tanpa reload,
  kirim manual dengan optimistic UI (status Mengirim…/Gagal),
  pesan `source=phone` berlabel "dari HP", loading & error state.
- API: `GET /api/inbox/chats`, `GET /api/inbox/chats/[id]`,
  `POST /api/inbox/send` (via `enqueueSend`, bukan kirim langsung),
  `POST /api/inbox/contacts/tag`, `POST /api/inbox/contacts/import`,
  `GET /api/inbox/stream` (SSE channel `reza:inbox`).
  "Belum dibaca" = pesan masuk setelah balasan terakhir kita (heuristik,
  tanpa kolom tambahan). Semua butuh sesi admin (401 tanpa sesi).

## Cara reproduksi E2E

```bash
cd apps/web
pnpm e2e:reset-db          # hapus data E2E + terapkan migrasi ke PGlite
# stop server lama bila ada, lalu:
export DATABASE_URL="pglite://$HOME/workspace/reza-ai/apps/web/data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
export E2E_TEST_API=1
npx next start -p 3100
npx playwright test inbox.spec.ts   # DB harus fresh; satu file per run
```

Catatan urutan: reset DB dulu, BARU start server (jangan reset saat server
jalan — PGlite yang sudah terbuka bisa tetap melihat data lama; ini
keterbatasan E2E sandbox, bukan bug aplikasi).

## Skenario E2E (e2e/inbox.spec.ts)

1. **Setup + login** — admin via wizard `/setup`.
2. **Navigasi** — dashboard -> link "Kotak Masuk" -> `/inbox` kosong
   ("Belum ada percakapan").
3. **Harness** — `POST /api/test/inbox/harness` menyalakan FakeGateway +
   consumer ingest/send (fungsi produksi `@reza-ai/core`) in-process.
4. **Pesan masuk realtime** — simulate pesan dari nomor baru -> chat +
   pesan tampil TANPA reload (SSE), badge unread "1", badge Full + Lead.
5. **Kirim dari UI** — balasan diketik -> optimistic tampil langsung ->
   `GET /api/test/inbox/sent` membuktikan FakeGateway menerima
   `{to, body}` -> DB mencatat `fromMe=true, source="dashboard"`.
6. **Impor Internal** — tempel "628990003344" + "nomor-ngawur" -> hasil
   "1 nomor ditandai Internal. Tidak dikenali: nomor-ngawur." -> pesan
   dari nomor itu otomatis ignored (tidak tampil di Semua) -> tampil di
   tab Disembunyikan dengan badge Internal.
7. **Pesan dari HP** — simulate `{fromMe: true, source: "phone"}` ->
   tampil di thread berlabel "dari HP" -> DB: `fromMe=true,
   source="phone"` (hook Task 8).
8. **Proteksi** — API inbox tanpa sesi -> 401.
9. **Zero console error/pageerror.**

## Kejujuran simulasi

- Yang **disimulasikan**: HANYA pesan masuknya (via
  `POST /api/test/inbox/simulate`, seolah pelanggan mengirim via WhatsApp)
  dan gateway-nya (FakeGateway, bukan Baileys).
- Yang **real**: `enqueueIngest` -> poller -> `processInboundMessage` ->
  PGlite; `POST /api/inbox/send` -> `enqueueSend` -> poller ->
  `processSendJob` (termasuk limiter) -> `FakeGateway.send`;
  publish/subscribe channel `reza:inbox`; SSE; seluruh render UI.
- **Kenapa worker tidak jalan sebagai proses terpisah di E2E:**
  `REDIS_URL=memory://` (ioredis-mock) hanya hidup di memori satu proses
  — tidak bisa dibagi antara proses web dan worker; dan satu dataDir
  PGlite tidak boleh dibuka dua proses. Karena itu harness E2E
  (`src/lib/inbox-harness.ts`, aktif hanya bila `E2E_TEST_API=1`)
  menjalankan "worker mini" di dalam proses server Next.js — memakai
  FUNGSI PRODUKSI yang sama persis dengan `apps/worker`
  (`processInboundMessage`, `processSendJob`, `checkSendLimit`,
  `enqueueIngest`/`enqueueSend`, `drain*Fallback`,
  `start*FallbackPoller`, `publishInboxEvent` dari `@reza-ai/core`).
- Transport antrean di E2E = Redis list fallback, bukan BullMQ
  (BullMQ butuh skrip Lua Redis asli — pola yang sama dengan wa-command
  di Task 4). Di produksi (Redis asli) antrean lewat BullMQ.
- Dukungan `WA_GATEWAY=fake` di `apps/worker` adalah fitur produksi
  (bukan E2E): worker asli bisa jalan dengan FakeGateway bila
  `WA_GATEWAY=fake` — terbukti boot tanpa crash di smoke test.

## Keputusan desain

- **Filter, bukan drop**: grup/status/broadcast/nomor owner/kontak Internal
  tetap disimpan (Contact/Chat/Message) dengan `Chat.ignored=true` —
  bisa diaudit dan ditampilkan di tab "Disembunyikan". Grup memakai
  kontak semu `group:<id>` per percakapan (tidak menabrak kontak personal
  anggotanya); status memakai satu kontak `broadcast`.
- **Limiter fixed-window global 20/menit** di Redis (`INCR` + `EXPIRE`);
  panggilan yang ditolak tetap memakai slot (mencegah retry storm).
  Worker BullMQ menjadwalkan ulang dengan `delay`; poller fallback
  memakai `reza:send:paused-until`.
- **Unread tanpa kolom baru**: pesan masuk setelah `fromMe` terakhir.
  Pesan dari HP (`source=phone`, `fromMe=true`) ikut menandai "sudah
  dibaca" — wajar karena itu balasan kita sendiri.
- **Mode badge**: `Chat.modeOverride` bila diisi, else `aiMode` global
  (Task 3). Label: Full/Semi/Nonaktif.

## Hook untuk Task 8 (pause AI saat reja balas manual)

- `Message.source = "phone"` + `fromMe = true` = "pesan ini diketik/
  dikirim dari HP reja, bukan dari dashboard, bukan dari AI".
- `Message.source = "dashboard"` + `fromMe = true` = "dikirim manual
  dari halaman /inbox".
- Keduanya menandai balasan manusia. Task 8 (AI reply) membaca flag ini:
  bila ada pesan `fromMe` (source phone/dashboard) yang lebih baru dari
  pesan masuk terakhir yang belum ditangani AI -> pause AI untuk chat itu
  (set `Chat.aiPaused=true` / `pausedUntil`), supaya AI tidak menimpa
  balasan reja.
- Event `reza:inbox` `{chatId, messageId, type: "new-message"}` juga bisa
  dipakai Task 6/8 sebagai pemicu pipeline AI (bedakan via
  `Message.fromMe`/`source` — jangan balas pesan sendiri).
