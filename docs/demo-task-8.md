# Demo Task 8 — Wiring AI ke WhatsApp: mode, draf, handoff, jeda

Tanggal: 2026-10-07. Dengan Task 8, **Fase 1 MVP dinyatakan selesai**:
agen Reza berjalan end-to-end — pesan WhatsApp masuk → AI membalas
otomatis (mode Full), menyiapkan draf untuk disetujui (mode Semi),
atau menyerahkan ke Reza (handoff) — plus jeda otomatis saat Reza
membalas manual dari HP.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 146/146 hijau (14 file; 13 test baru Task 8) |
| Unit test `apps/web` | 50/50 hijau (5 file; tidak ada perubahan perilaku) |
| E2E Playwright `ai-agent.spec.ts` (chromium asli) | 8/8 hijau, zero console error/pageerror |
| E2E regresi | inbox 9/9, playground 6/6, knowledge 9/9, settings 4/4, whatsapp 9/9, auth 8/8 — semua hijau |
| Build | core + worker + web (`next build`) sukses, lint bersih |
| Worker boot | `tsx src/index.ts` — 8 antrian terdaftar, `ai-reply` aktif, tanpa crash |

## Yang dibangun

**Core (`packages/core/src/ai-pipeline.ts`, baru):**
- `resolveMode(chat, general)`: `Chat.modeOverride ?? general.aiMode`
  → `'full'|'semi'|'off'`. Override chat menang atas global; nilai asing → `full`.
- **Debounce self-correcting** (`scheduleAiReply` + konsumen `ai-reply`):
  setiap pesan masuk menggeser kunci Redis `reza:ai:debounce:<chatId>`
  (deadline = now + `debounceSec`). Job yang bangun lebih awal
  **menjadwalkan ulang dirinya** dengan sisa delay — bubble chat beruntun
  hanya memicu SATU `generateReply` setelah window sepi. Lock
  `reza:ai:run:<chatId>` (SET NX, EX 600 dtk) mencegah dua job mengerjakan
  chat yang sama bersamaan.
- **Konsumen `ai-reply`** (`processAiReply`, tidak melempar untuk kondisi
  bisnis): (a) lewati bila chat ignored / `aiPaused` (manual: `pausedUntil`
  belum lewat; handoff: `pausedUntil` null) / pesan terakhir dari kita;
  `pausedUntil` yang sudah lewat → auto-resume; (b) 10 pesan terakhir →
  `generateReply` (Task 7, tidak pernah throw); (c) `handoff=true` ATAU
  `confidence < handoffConfidenceThreshold` → alur handoff; (d) mode full →
  `gateway.presence(pn, "composing")` + jeda acak `replyDelayMinSec`–
  `replyDelayMaxSec` + `enqueueSend(chatId, reply, "ai")`; (e) mode semi →
  `Draft` pending (confidence/reason/sourcesUsed) + notifikasi owner;
  (f) mode off → diam.
- **Handoff**: `Chat.aiPaused=true` (tanpa batas waktu), baris `Handoff`
  `{reason, summary}` (ringkasan aturan sederhana dari pesan terakhir —
  jujur didokumentasikan, bukan ringkasan LLM), notifikasi langsung via
  gateway ke nomor owner: `Handoff: <nama> (<nomor>). Alasan: <reason>.
  Ringkasan: <summary>. Buka: <APP_URL>/inbox?chat=<chatId>`.
- **Jeda manual** (di `processInboundMessage`): pesan `fromMe` dengan
  `source="phone"` → `Chat.aiPaused=true, pausedUntil=now+manualPauseHours`.
  Pesan `fromMe` dari dashboard/AI tidak memicu jeda.
- **Notifikasi owner** (`notifyOwner`): kirim langsung via gateway (tidak
  lewat antrean kirim — notifikasi operasional tidak ikut limiter 20/menit);
  gagal kirim dicatat, tidak menggagalkan pipeline.
- Transport antrean: BullMQ `ai-reply` (delay untuk debounce) + list
  fallback `reza:ai-reply:fallback` yang menghormati `notBefore`
  (pola Task 5) + `startAiReplyFallbackPoller`.
- Event inbox baru: `draft-created`, `handoff-created` (dipindah ke modul
  `inbox-events.ts` agar tidak import siklis dengan `ingest.ts`).

**Pengaturan umum baru** (`general.*`, bisa diubah di /settings):
| Setting | Default | Arti |
|---|---|---|
| `debounceSec` | 10 | AI menunggu selama ini setelah pesan terakhir sebelum membalas |
| `replyDelayMinSec` / `replyDelayMaxSec` | 30 / 120 | Jeda "mengetik" acak sebelum balasan full-mode dikirim |
| `handoffConfidenceThreshold` | 0,5 | Confidence di bawah ini → handoff |
| `manualPauseHours` | 4 | Lama AI diam setelah Reza membalas dari HP |

Nilai di luar batas dikembalikan ke default (tidak merusak pipeline);
`PUT /api/settings` memvalidasi semuanya.

**Worker (`apps/worker/src/index.ts`):** prosesor `ai-reply` terdaftar +
poller fallback; dependensi `AiPipelineDeps` (prisma, redis, gateway,
`getGeneralSettings`, `getEffectiveProviderConfig("chat"/"embedding")`).

**Web (`apps/web/`):**
- `/inbox`: kartu **Draf AI** per chat (teks + badge keyakinan + tombol
  Setujui / Edit / Tolak); banner **"Chat dijeda — \<reason\>"** + tombol
  **"Lanjutkan AI"**; badge **"AI jeda"**; pemilih **mode override**
  (Auto/Full/Semi/Nonaktif) per chat; tautan langsung `?chat=<id>` dari
  notifikasi WA membuka thread yang dimaksud. SSE ikut me-refresh saat
  event `draft-created`/`handoff-created`/`chat-updated` tiba.
- API (semua butuh sesi admin, 401 tanpa sesi):
  `GET /api/inbox/drafts?chatId=`,
  `POST /api/inbox/drafts/[id]/approve` (body opsional `{body}` = hasil
  edit → status `edited`, lalu kirim via `enqueueSend` source `"ai"`),
  `POST /api/inbox/drafts/[id]/reject`,
  `PATCH /api/inbox/chats/[id]` (`{modeOverride}`),
  `POST /api/inbox/chats/[id]/resume` (aiPaused=false + handoff open →
  `resumed`).
  `GET /api/inbox/chats` dan `GET /api/inbox/chats/[id]` ikut
  mengembalikan `aiPaused`, `modeOverride`, draf pending, dan handoff open.

## Cara reproduksi E2E

```bash
cd apps/web
pnpm e2e:reset-db          # DB fresh DULU (jangan saat server jalan)
# stop server lama bila ada, lalu:
export DATABASE_URL="pglite://./data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
export E2E_TEST_API=1
npx next start -p 3100
npx playwright test ai-agent.spec.ts   # DB harus fresh; satu file per run
```

Pengaturan E2E (`debounceSec=1`, jeda 1–2 dtk) adalah **nilai jujur yang
dikonfigurasi lewat API** — bukan percepatan waktu: seluruh pipeline
(debounce, delay, poller) berjalan dengan kode produksi yang sama.

## Skenario E2E (e2e/ai-agent.spec.ts)

1. **Setup + login** — admin via wizard `/setup`.
2. **Mock provider + seed + harness + pengaturan** — slot embedding & chat
   diarahkan ke server HTTP mock lokal (pola Task 6/7), seed knowledge
   "Daftar Harga Tipe Verona — DATA UJI (fiktif)", harness inbox
   (FakeGateway + consumer ingest/send/**ai-reply** produksi), lalu
   `PUT /api/settings` (debounce 1 dtk, jeda 1–2 dtk, threshold 0,5).
3. **(a) MODE FULL** — override `full` via PATCH → pesan "Halo, info harga
   tipe Verona?" → FakeGateway mencatat balasan AI (teks persis dari mock
   chat) → UI `/inbox` menampilkan pesan AI + pemilih mode = Full.
4. **(b) MODE SEMI** — override `semi` → pesan baru → **Draft pending**
   muncul (teks + Keyakinan 90%) dan **tidak ada** balasan langsung →
   notifikasi "Draf AI" sampai ke nomor owner di FakeGateway → kartu draf
   tampil di UI → klik **Setujui** → pesan terkirim ke lead → draf hilang.
5. **(c) HANDOFF** — "bisa diskon 10%?" → gerbang intent sensitif →
   baris `Handoff` + `aiPaused` di DB → notifikasi "Handoff: …Negosiasi
   harga/diskon…" ke owner → UI: banner "Chat dijeda — …" + badge "AI
   jeda" → klik **"Lanjutkan AI"** → jeda lepas → pesan berikutnya dibalas
   AI lagi (bukti resume benar-benar jalan).
6. **(d) JEDA MANUAL** — pesan `fromMe` + `source="phone"` (simulasi
   balasan dari HP) → `aiPaused` + `pausedUntil` ~4 jam → pesan baru dari
   lead **tidak dibalas dan tidak dibuatkan draf** → badge "AI jeda" di UI.
7. **API terproteksi** — 5 endpoint baru → 401 tanpa sesi.
8. **Zero console error & pageerror.**

## Yang JUJUR disimulasikan (dan yang tidak)

Disimulasikan: (1) gateway WhatsApp (FakeGateway, bukan Baileys — worker
asli tidak bisa jalan sebagai proses terpisah di sandbox karena
`REDIS_URL=memory://` tidak lintas-proses dan PGlite tidak boleh dibuka
dua proses); (2) provider embedding (server HTTP mock lokal, vektor hash
deterministik); (3) provider chat (server HTTP mock lokal, JSON canned);
(4) isi pesan masuknya; (5) data knowledge ("DATA UJI (fiktif)" —
**harga Rp950 juta BUKAN harga Grand Duta City sungguhan**).

Tidak disimulasikan: debounce, resolusi mode, `generateReply` (retrieval
hybrid asli ke PGlite + prompt + parsing), draf, handoff, notifikasi
owner, jeda manual, antrean kirim + limiter, event SSE, dan seluruh UI —
semuanya kode produksi yang sama dipakai `apps/worker`.

## Status MVP Fase 1

| Task | Status |
|---|---|
| 1. Fondasi (schema, gateway interface, enkripsi, health) | ✅ hijau |
| 2. Auth admin (TOTP, sesi Redis) | ✅ hijau |
| 3. Settings provider AI + umum | ✅ hijau |
| 4. Worker WhatsApp (Baileys, QR, wa-command) | ✅ hijau |
| 5. Inbox realtime + kirim manual | ✅ hijau |
| 6. Knowledge base + hybrid retrieval | ✅ hijau |
| 7. AI reply engine + playground | ✅ hijau |
| 8. Wiring AI → WhatsApp (mode, draf, handoff) | ✅ hijau |

**Risiko & catatan jujur untuk Fase 2:**
- Handoff dibuat untuk SETIAP kegagalan `generateReply` (termasuk slot
  chat belum dikonfigurasi) — benar sebagai fail-safe, tapi owner akan
  menerima notifikasi WA per chat bila konfigurasi belum lengkap.
  Pertimbangkan mode "tenang" (tahan notifikasi, cukup banner di UI)
  bila volume tinggi.
- Ringkasan handoff (`summary`) adalah ekstraksi aturan sederhana dari
  pesan terakhir, bukan ringkasan LLM — cukup untuk notifikasi, jangan
  dianggap analisis.
- Jeda "mengetik" 30–120 dtk menahan worker `ai-reply` (concurrency 1)
  selama itu — pada volume tinggi, naikkan concurrency worker atau
  pindahkan delay ke job terpisah.
- `enqueueSend` untuk balasan AI memakai limiter global 20/menit yang
  sama dengan kiriman dashboard — lonjakan chat bisa mengantrekan
  balasan AI di belakang kiriman manual.
- E2E memakai FakeGateway; perilaku Baileys asli (echo pesan fromMe,
  presence, reconnect) tetap perlu uji manual saat pairing HP.
