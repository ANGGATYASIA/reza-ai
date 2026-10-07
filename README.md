# Reza AI

WhatsApp Sales Agent untuk Grand Duta City South of Jakarta. Menerima pesan WhatsApp calon pembeli, menjawab dengan persona "Reza", mencatat profil lead, lalu menyerahkan ke tim saat waktunya. Target: 2 closing per bulan dari leads organik.

Task 1 membangun fondasinya: monorepo pnpm berisi dashboard Next.js 16, worker Node + BullMQ 5, dan package `@reza-ai/core` (Prisma 6, util WIB, kontrak gateway WhatsApp, health check).

Task 2 menambahkan autentikasi admin: wizard penyiapan `/setup`, login dua langkah (`/login`: kata sandi + TOTP), sesi opaque di Redis, rate limit login, dan proteksi route via `proxy.ts` + `requireAdmin()`. Detail di bawah.

## Arsitektur

```
reza-ai/
  apps/web/        Next.js 16 App Router — dashboard admin (Bahasa Indonesia)
  apps/worker/     Node + BullMQ — 8 antrian (termasuk wa-command), heartbeat ke Redis tiap 15 detik
  packages/core/   Prisma schema + client, util WIB, stage pipeline,
                   interface WhatsAppGateway, enkripsi AES-256-GCM, health check
  docker-compose.yml   postgres (pgvector/pgvector:pg16) + redis + web + worker
```

Endpoint `GET /api/health` mengembalikan status **asli** tiap komponen:

```json
{ "db": "ok", "redis": "ok", "worker": "ok", "ts": "2026-10-06T16:10:00.000Z" }
```

`db` lolos hanya bila `SELECT 1` via Prisma berhasil, `redis` hanya bila `PING` berhasil, `worker` hanya bila heartbeat worker di Redis lebih muda dari 60 detik. Kode 503 bila ada yang `error`.

## Prasyarat

- Node.js 20+ dan pnpm 12+
- Salah satu: Docker + compose plugin, atau PostgreSQL 16 + Redis 7 terinstal lokal

## Cara jalan lokal

### Skenario A: Docker Compose (untuk VPS / Task 17)

```bash
cp .env.example .env
# isi MASTER_KEY (64 karakter hex) di .env

docker compose up --build -d
docker compose exec web pnpm --filter @reza-ai/core prisma:migrate
curl http://localhost:3000/api/health
```

### Skenario B: PostgreSQL + Redis native

```bash
cp .env.example .env
# DATABASE_URL=postgresql://reza:reza@localhost:5432/reza_ai
# REDIS_URL=redis://localhost:6379
# isi MASTER_KEY

createdb reza_ai            # sekali saja
pnpm install
pnpm --filter @reza-ai/core prisma:migrate

# terminal 1 — web
pnpm --filter @reza-ai/web dev
# terminal 2 — worker
pnpm --filter @reza-ai/worker dev

curl http://localhost:3000/api/health
# -> {"db":"ok","redis":"ok","worker":"ok","ts":"..."}
```

Matikan worker (Ctrl+C di terminal 2), tunggu 60 detik, panggil `/api/health` lagi: `worker` berubah jadi `error` dan kode HTTP jadi 503. Nyalakan worker lagi: kembali `ok`. Itu bukti statusnya dihitung, bukan di-hardcode.

### Skenario C: sandbox tanpa PostgreSQL/Redis (test saja)

Test Vitest tidak butuh service asli:

- Postgres diganti PGlite (Postgres asli dalam WASM, mendukung ekstensi `vector`)
- Redis diganti `ioredis-mock`

```bash
pnpm install
pnpm test
```

Di VPS/CI, test yang sama bisa diarahkan ke service asli lewat `DATABASE_URL` dan `REDIS_URL` tanpa mengubah logika.

## Migrasi database

```bash
pnpm --filter @reza-ai/core prisma:migrate   # prisma migrate dev
```

Migrasi pertama mengaktifkan `CREATE EXTENSION IF NOT EXISTS vector;` lalu membuat semua tabel Fase 1. Migrasi kedua menambah kolom `tsv` (tsvector, generated dari judul + isi chunk), index GIN untuk pencarian teks, dan index HNSW untuk pencarian vektor. Migrasi ketiga & keempat menambah kolom sumber mentah (`content`, `data`) + `errorMessage` di `KnowledgeItem`, lalu mengubah `data` dari BYTEA ke TEXT (base64 — driver adapter PGlite merusak nilai Bytes biner). Prisma tidak mendukung tsvector/HNSW secara native, jadi migrasi non-standar ditulis sebagai SQL manual.

Cek ekstensi dan tabel:

```sql
\dx                      -- harus ada "vector"
\dt                      -- 18 tabel: Admin, Setting, Provider, Contact, Chat,
                         -- Message, Draft, Handoff, KnowledgeItem, KnowledgeChunk,
                         -- Asset, LeadProfile, LeadEvent, FollowUp, ExamplePair,
                         -- Playbook, UnitType
```

## Basis pengetahuan (knowledge base)

Halaman `/knowledge` (link dari dashboard, khusus admin). Sumber yang didukung:

| Tipe | Cara masuk | Ekstraksi |
|------|-----------|-----------|
| Teks | Form + tombol "Pakai template Fact Sheet Proyek" | Langsung, section dari heading markdown |
| URL  | Form URL | Fetch (timeout 15 dtk) + Readability (`@mozilla/readability` + `linkedom`) |
| PDF  | Upload (maks 10MB) | `unpdf` (murni JS, tanpa native dependency); berkas disimpan base64 di DB |

Alur ingest (job `knowledge-item` di antrean `ingest`, diproses worker/`ingestKnowledgeItem`): extract → pecah section → `chunkText` (~512 token, overlap ~64 token, estimasi 1 token ≈ 4 karakter; tiap chunk diawali `Judul: …\nBagian: …`) → `embedBatch` (POST `{baseUrl}/embeddings`, 32 teks/request) → simpan chunk (vector + tsv terisi otomatis). Idempoten: chunk lama dihapus dulu. Gagal di tahap mana pun → status `failed` + pesan (tampil di UI).

**Pencarian hybrid** (`hybridSearch`, dipakai Task 7 untuk AI reply): embed query → 3×topK kandidat vector (`ORDER BY embedding <=> $1`, index HNSW, cosine) + 3×topK kandidat full-text (`tsv @@ plainto_tsquery('simple', …)`, index GIN; kamus `simple` karena Postgres tak punya kamus Indonesia) → gabung via **Reciprocal Rank Fusion (k=60)** → top-K `{chunk, score, source: vector|fts|both, itemTitle}`. Item `validUntil` lewat dan yang belum `ready` selalu disaring.

**Indeks ulang**: tombol "Indeks ulang embeddings" mengantrekan job `reindex` (embed ulang semua chunk; bila dimensi probe ≠ dimensi kolom, kolom di-`ALTER` + index HNSW dibangun ulang; dimensi aktif dicatat di Setting `knowledge.embeddingDim`). Otomatis juga saat model embedding berubah — hook di `PUT /api/settings` membandingkan model lama vs baru.

API (semua butuh sesi admin): `GET/POST /api/knowledge/items`, `GET/DELETE /api/knowledge/items/[id]`, `POST /api/knowledge/search`, `GET/POST /api/knowledge/reindex`.

Catatan: tidak ada seed data knowledge — admin mengunggah manual lewat dashboard.

## AI Reply Engine + Playground (Task 7)

`generateReply()` di `packages/core/src/ai-engine.ts` (diekspor dari `@reza-ai/core`) — balasan grounded dengan persona Reza, bisa diuji tanpa WhatsApp. Tidak pernah melempar: setiap kegagalan menjadi handoff yang valid.

**Struktur prompt** (`buildReplyPrompt`, satu system message): (a) identitas — `{name}` (default "Reza"), marketing Grand Duta City South of Jakarta; (b) kunci suara eksplisit (slang-id intensitas rendah): sapaan saya-kamu ("kamu", bukan "Anda"/"Saudara"), partikel sih/kok sesekali, TANPA EMOJI, tidak pernah mengaku AI, pantangan hiruk pikuk/krusial/em dash/paralelisme "bukan hanya X tetapi juga Y"/pembuka klise/penutup ritual; (c) guardrail — JANGAN PERNAH menjanjikan diskon/harga final/jadwal pasti, HANYA fakta dari konteks (sitasi internal `[1]`, `[2]` per fakta, tidak ditulis di balasan), kalau tidak ada di konteks katakan belum tahu dan arahkan tanya langsung ke Reza (jangan mengarang), maks 3 kalimat gaya chat; (d) riwayat 10 pesan terakhir ("Lead: …" / "Reza: …"); (e) chunk bernomor `[1..k]` dari `content` + `(Sumber: itemTitle)`. Model diminta mengeluarkan HANYA JSON `{reply, confidence 0-1, handoff, reason, sourcesUsed}`.

**Gerbang handoff** (tanpa LLM, setelah retrieval): (1) intent sensitif via pola keyword — negosiasi (`diskon|nego|potongan harga|kurang.*harga|best price`), survei (`survei|survey|lihat (lokasi|unit)|jadwal kunjung`), legal (`somasi|pengacara|hukum|polisi`, dicek sebelum komplain supaya "lapor polisi" jadi legal), komplain (`komplain|kecewa|tipu|menipu|lapor`) — masing-masing membawa reason Bahasa Indonesia; (2) 0 chunk → handoff "Pertanyaan di luar knowledge yang tersedia". LLM dipanggil hanya bila lolos gerbang: `POST {baseUrl}/chat/completions` (`temperature: 0.2`, `response_format: json_object`, timeout 60 dtk), output divalidasi Zod; JSON rusak → coba ekstrak substring `{…}` → masih gagal → handoff "Respon AI tidak valid, diteruskan ke Reza". Hasil: `{reply, confidence, handoff, reason, sourcesUsed, sources: [{index, itemTitle}]}` (`sources` dibangun lokal untuk UI).

**Playground** — halaman `/playground` (link dari dashboard, khusus admin): admin berperan sebagai lead, tiap balasan menampilkan badge "Keyakinan N%", daftar sumber yang dikutip, dan banner "Diteruskan ke Reza — \<reason\>" bila handoff. API `POST /api/playground/chat` menjalankan `generateReply` asli (retrieval + LLM via slot chat yang dikonfigurasi; 400 dengan pesan jelas bila slot chat belum disiapkan). Persona (nama + gaya bahasa) diambil dari Pengaturan umum.

Detail teknis + hasil E2E: `docs/demo-task-7.md`. Hook untuk Task 8 (wiring WhatsApp: `generateReply` → `Handoff`/`Draft`/`enqueueSend`) ada di akhir dokumen itu.

## Cara kerja agen (Task 8 — MVP selesai)

Alur pesan masuk sampai balasan/handoff:

```
WhatsApp ──▶ onMessage ──▶ antrean `ingest` ──▶ processInboundMessage
                                                        │
                              ┌─────────────────────────┴──────────────────────────┐
                              │ fromMe + source="phone"                            │ pesan biasa (non-ignored)
                              │ (Reza balas dari HP)                             │
                              ▼                                                  ▼
                    Chat.aiPaused=true,                            scheduleAiReply:
                    pausedUntil=now+X jam                          kunci debounce  ──▶ antrean `ai-reply`
                              │                                              │
                              │                                              ▼
                              │                                   processAiReply (konsumen):
                              │                                    1. lewati bila ignored / dijeda /
                              │                                       pesan terakhir dari kita
                              │                                    2. 10 pesan terakhir → generateReply
                              │                                    3. handoff? ──▶ Handoff row + aiPaused
                              │                                                    + notifikasi WA ke owner
                              │                                    4. mode full ──▶ "mengetik…" + jeda acak
                              │                                                    + enqueueSend (source "ai")
                              │                                       mode semi ──▶ Draft pending
                              │                                                    + notifikasi WA ke owner
                              │                                       mode off  ──▶ diam
                              └─────────────────────────┬──────────────────────────┘
                                                        ▼
                                              antrean `send` ──▶ WhatsApp
                                              (limiter 20/menit)
```

**Debounce self-correcting:** tiap pesan baru menggeser deadline debounce
per chat (`general.debounceSec`, default 10 dtk); job yang bangun lebih
awal menjadwalkan ulang dirinya — bubble chat beruntun dibalas sekali.

**Pengaturan baru di /settings** (bagian "Waktu & jeda AI"): `debounceSec`
(10), `replyDelayMinSec`/`replyDelayMaxSec` (30/120 — jeda "mengetik" acak),
`handoffConfidenceThreshold` (0,5), `manualPauseHours` (4).

**Di /inbox (khusus admin):** kartu Draf AI (Setujui / Edit / Tolak),
banner "Chat dijeda — \<alasan\>" + tombol "Lanjutkan AI", badge "AI
jeda", dan pemilih mode per chat (Auto/Full/Semi/Nonaktif). Notifikasi WA
ke owner menyertakan tautan `<APP_URL>/inbox?chat=<id>` — pastikan
`APP_URL` di `.env` berisi URL publik dashboard.

**Cara demo untuk Reza** (butuh HP terpairing via halaman /whatsapp):
1. Kirim "Halo, info harga" dari nomor lain → tunggu ~10 dtk + jeda acak →
   balasan AI masuk otomatis (mode Full).
2. Ubah mode chat ke Semi di /inbox → kirim pesan baru → draf muncul di
   /inbox + notifikasi WA ke nomor owner → klik Setujui → terkirim.
3. Kirim "bisa diskon 10%?" → banner handoff + notifikasi ke owner → klik
   "Lanjutkan AI" → AI aktif lagi.
4. Balas manual dari HP → AI diam 4 jam (badge "AI jeda").

Detail teknis + hasil E2E: `docs/demo-task-8.md`.

## Skrip pnpm

| Perintah        | Arti                                              |
|-----------------|---------------------------------------------------|
| `pnpm install`  | instal semua workspace                            |
| `pnpm build`    | build core, web, worker                           |
| `pnpm test`     | Vitest di semua package                           |
| `pnpm lint`     | ESLint di semua package                           |
| `pnpm dev:web`  | jalankan dashboard (port 3000)                    |
| `pnpm dev:worker`| jalankan worker                                  |

## Variabel environment

Lihat `.env.example` untuk daftar lengkap. Yang wajib ada sebelum jalan:

- `DATABASE_URL` — koneksi PostgreSQL
- `REDIS_URL` — koneksi Redis
- `MASTER_KEY` — 32 byte hex untuk enkripsi tabel Setting dan secret TOTP (AES-256-GCM)
- `TOTP_ISSUER` — nama yang tampil di aplikasi autentikator (default `Reza AI`)
- `WA_AUTH_DIR` — direktori state auth Baileys (dipakai Task 4)
- `OWNER_WA_NUMBER` — nomor WhatsApp owner untuk notifikasi handoff (default `082114812842`)

## Troubleshooting: unduhan engine Prisma diblokir jaringan

`pnpm install` menjalankan postinstall `@prisma/engines` yang mengunduh binary dari `binaries.prisma.sh`. Bila jaringan Anda memblokir host itu (gejala: `ECONNRESET` saat install), unduh manual via curl lalu tunjukkan lokasinya lewat environment variable:

```bash
# 1. Lihat commit engine yang dibutuhkan
node -e "console.log(require('./node_modules/@prisma/engines-version').enginesVersion)"
# mis. c2990dca591cba766e3b7ef5d9e8a84796e47ab7

# 2. Unduh manual (ganti <commit> dengan hasil di atas)
C=<commit>; P=debian-openssl-3.0.x
curl -sL -o /tmp/schema-engine.gz https://binaries.prisma.sh/all_commits/$C/$P/schema-engine.gz
curl -sL -o /tmp/libquery_engine.so.node.gz https://binaries.prisma.sh/all_commits/$C/$P/libquery_engine.so.node.gz
gunzip -kf /tmp/schema-engine.gz /tmp/libquery_engine.so.node.gz
chmod +x /tmp/schema-engine

# 3. Pakai tanpa mengunduh ulang
export PRISMA_SCHEMA_ENGINE_BINARY=/tmp/schema-engine
export PRISMA_QUERY_ENGINE_LIBRARY=/tmp/libquery_engine.so.node
pnpm install   # atau: pnpm rebuild @prisma/engines @prisma/client
```

Kedua variable juga berlaku saat runtime (`prisma generate`, `prisma migrate`, `next start`, worker), jadi cara ini cukup untuk seluruh alur.

## Autentikasi admin (Task 2)

### Membuat akun pertama

Buka `/setup` di browser (hanya aktif bila tabel `Admin` masih kosong):

1. Isi email + kata sandi (minimal 12 karakter).
2. Pindai kode QR dengan aplikasi autentikator (Google Authenticator, Authy, dsb.),
   atau masukkan secret manual. Simpan secret di brankas kata sandi.
3. Masukkan kode 6 digit untuk verifikasi -> selesai -> `/login`.

### Cara login

`/login` dua langkah: email + kata sandi dulu, lalu kode 6 digit dari aplikasi
autentikator. Sesi berlaku 12 jam (diperpanjang otomatis selama dipakai).
Tombol **Keluar** di dashboard menghancurkan sesi.

5x gagal login dari satu IP dalam 15 menit -> `429 "Terlalu banyak percobaan,
coba lagi dalam 15 menit."` Login sukses me-reset hitungan.

### Terkunci / lupa (reset darurat)

Tidak ada endpoint HTTP untuk reset — hanya via shell server (akses shell = akses penuh):

```bash
cd packages/core
# lihat daftar admin
DATABASE_URL=... node scripts/reset-admin.mjs --list
# kosongkan 2FA -> login berikutnya wajib aktivasi ulang di /setup-2fa
DATABASE_URL=... node scripts/reset-admin.mjs --reset-totp admin@contoh.id --yes
# ganti kata sandi dengan yang acak (dicetak sekali ke terminal)
DATABASE_URL=... node scripts/reset-admin.mjs --reset-password admin@contoh.id --yes
```

### Untuk developer: memakai proteksi di task berikutnya

```ts
// Route Handler (API)
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response; // 401 otomatis
  // ... auth.admin = { id, email }
}

// Server Component / halaman
import { requireAdminPage, getCurrentAdmin } from "@/lib/auth-server";

export default async function Page() {
  const admin = await requireAdminPage(); // redirect /login bila tak ada sesi
}
```

Proteksi berlapis: `src/proxy.ts` (Next 16; redirect `/login` untuk halaman dan
401 untuk API bila cookie sesi tidak ada) + `requireAdmin()` di setiap handler
(validasi token ke Redis, otoritatif). Keputusan desain sesi: opaque token acak
di Redis (`reza:session:<token>`, TTL 12 jam sliding) — bukan JWT — agar logout
dan pemutusan paksa bersifat instan. Lihat komentar di `apps/web/src/lib/auth.ts`.

## Pengaturan provider AI / BYOK (Task 3)

Halaman `/settings` (link "Pengaturan" di dashboard, terproteksi login):

- **Provider AI** — 4 slot: Chat, Embedding, Vision, Transkripsi. Tiap slot:
  nama, base URL, API key, model (dropdown terisi via "Deteksi model" ->
  `GET {baseUrl}/models`), toggle Aktif, dan tombol "Tes koneksi" (uji
  sungguhan per slot + latensi). Slot non-Chat punya opsi "Sama dengan Chat":
  bila aktif, field-nya disabled dan mengikuti konfigurasi slot Chat.
- **Umum** — nama persona (default `Reza`), gaya bahasa
  (santai/profesional santai/formal — dipakai Task 7), nomor WA owner
  (default `082114812842`), mode AI global (penuh/semi/mati), jam follow up
  mulai–selesai (default 08.00–20.00 WIB).

Keamanan kunci:

- API key disimpan di tabel `Setting` terenkripsi AES-256-GCM (`MASTER_KEY`).
- `GET /api/settings` tidak pernah mengembalikan key utuh — hanya
  `apiKeyMasked` (`••••` + 4 digit terakhir) dan `keySet`.
- `PUT /api/settings`: key baru dienkripsi; key lama dipertahankan bila field
  dikosongkan. "Deteksi model"/"Tes koneksi" memakai key tersimpan bila field
  dikosongkan.

Untuk developer (dipakai Task 4/worker):

```ts
import { getEffectiveProviderConfig, getGeneralSettings } from "@reza-ai/core";

// Config efektif satu slot: inherit sudah di-resolve, API key sudah didekripsi.
const chat = await getEffectiveProviderConfig("chat");
// -> { slot, name, baseUrl, apiKey, model, enabled, inherited } | null

const general = await getGeneralSettings();
// -> { personaName, personaTone, ownerWaNumber, aiMode, followupStart, followupEnd }
```

Detail penyimpanan (key `Setting`, relasi `Provider`): lihat
`packages/core/src/providers.ts` dan `docs/demo-task-3.md`. Tidak ada
environment variable baru di task ini.

## Koneksi WhatsApp via QR (Task 4)

Halaman `/whatsapp` (link dari dashboard) menampilkan kode QR dan status
koneksi nomor kerja Reza AI — datanya mengalir REAL dari worker via
Redis pub/sub (`reza:wa:status`) ke SSE `/api/whatsapp/stream`.

**Cara menghubungkan (butuh HP):**

1. Jalankan worker (`pnpm dev:worker` atau via compose).
2. Buka `/whatsapp` — kode QR tampil dengan status "Menunggu dipindai".
3. Di HP: WhatsApp → **⋮** → **Perangkat tertaut** → **Tautkan perangkat**,
   pindai kode di layar.
4. Status menjadi **"Terhubung: \<nama> (\<nomor>)"**. QR kedaluwarsa?
   Kode baru muncul otomatis.

**Arti status:** `qr` (pindai dari HP) · `connecting` (mencoba tersambung)
· `open` (sesi aktif) · `close` (terputus, worker mencoba ulang otomatis)
· `restricted` (akun dibatasi WhatsApp — lihat bawah).

**Tombol:** *Restart koneksi* (paksa sambung ulang, sesi tetap) dan
*Logout* — klik 2x konfirmasi — (hapus sesi di server, QR baru terbit).
Keduanya dikirim sebagai job ke antrean BullMQ `wa-command`.

**Penanganan error 463 (akun dibatasi):** worker menyetel flag Redis
`reza:wa:restricted=1` (TTL 24 jam), menampilkan banner di dashboard,
dan menahan semua pengiriman otomatis. Tidak ada auto-reconnect;
tombol *Restart* membersihkan flag lalu mencoba ulang. Task 11 membaca
flag ini untuk auto-pause.

**Lokasi auth:** state sesi Baileys di direktori `WA_AUTH_DIR`
(default `/data/wa-auth`, di-mount sebagai volume di compose — lihat
`.env.example`). Jangan commit isinya. Logout / pencabutan dari HP
menghapus seluruh isi direktori ini lalu menerbitkan QR baru.

Detail teknis + hasil E2E: `docs/demo-task-4.md`.

## Kotak Masuk (Task 5)

Halaman `/inbox` (link "Kotak Masuk" dari dashboard) menampilkan seluruh
percakapan WhatsApp — datanya mengalir REAL dari worker via
`processInboundMessage` (Contact/Chat/Message di database) ke SSE
`/api/inbox/stream` (channel Redis `reza:inbox`).

**Yang tampil:** daftar chat + pesan terakhir + badge jumlah belum dibaca,
badge mode AI (Full/Semi/Nonaktif — dari `modeOverride` chat atau `aiMode`
global), badge tag (Lead/Internal). Filter: Semua / Belum dibaca /
Disembunyikan. Chat grup, status WA, nomor owner sendiri, dan kontak
Internal otomatis disembunyikan (tetap tersimpan, bisa dibuka di tab
"Disembunyikan").

**Kirim manual:** ketik di kotak balasan -> `POST /api/inbox/send` ->
masuk antrean `send` (BullMQ di produksi) -> worker mengeksekusi lewat
gateway dengan limiter global 20 pesan/menit. Pesan dari HP reja
(`source=phone`, label "dari HP") ikut tercatat — Task 8 memakai flag ini
untuk pause AI otomatis supaya tidak menimpa balasan manual.

**Nomor internal:** panel "Nomor internal" menerima tempelan daftar nomor
(satu per baris/koma) -> dinormalisasi (08xx/628xx/+62) -> ditandai
Internal -> chat-nya otomatis disembunyikan. Tombol "Tandai Internal"
juga ada di tiap thread.

Detail teknis + hasil E2E: `docs/demo-task-5.md`.

## Testing & E2E di sandbox

Sandbox ini tidak punya PostgreSQL/Redis native (apt rusak), jadi:

| Kebutuhan | Sandbox | VPS / produksi |
|---|---|---|
| Database | `DATABASE_URL=pglite://./data/e2e` — PGlite (Postgres WASM) via driver adapter `pglite-prisma-adapter`; migrasi SQL asli tetap jalan via `packages/core/scripts/pglite-migrate.mjs` | `DATABASE_URL=postgresql://...` + `prisma migrate deploy` |
| Redis | `REDIS_URL=memory://` — in-memory via ioredis-mock (protokol Redis asli, tapi data hanya di memori proses ini) | `REDIS_URL=redis://...` (asli) |

**Catatan jujur**: mode `memory://` bukan server Redis asli — sesi & rate limit tidak terbagi antar proses dan hilang saat restart. Cukup untuk E2E satu proses; di VPS selalu pakai Redis asli.

**Build memakai webpack, bukan Turbopack** (`apps/web/package.json`: `next build --webpack`). Alasannya: `serverExternalPackages` hanya dihormati webpack di Next 16.3.8; Turbopack membundel `argon2` (native binding rusak) dan `@electric-sql/pglite` (pemetaan path `import.meta.url` rusak, WASM tidak termuat). Paket sensitif (`@reza-ai/core`, `@electric-sql/pglite`, `pglite-prisma-adapter`, `@prisma/client`, `argon2`) dieksternalkan di `next.config.ts` agar di-`require()` dari `node_modules` asli saat runtime.

Alur E2E lengkap (skenario di `apps/web/e2e/auth.spec.ts`, ringkasan di `docs/demo-task-2.md`):

```bash
cd apps/web
pnpm e2e:reset-db   # hapus data E2E + terapkan migrasi ke PGlite
# nyalakan server dengan env E2E (lihat docs/demo-task-2.md)
npx playwright test # butuh chromium di ~/.cache/ms-playwright
```
