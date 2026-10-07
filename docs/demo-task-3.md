# Demo Task 3 — Settings Terenkripsi + Konfigurasi Provider AI (BYOK)

Tanggal: 2026-10-07. Semua bukti direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + Redis in-memory), bukan mock.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 42/42 hijau (28 lama + 14 baru: masking, parser /models, inherit, enkripsi API key) |
| Unit test `apps/web` | 41/41 hijau (25 lama + 16 baru: deteksi model & tes koneksi dengan fetch mock) |
| E2E Playwright (chromium asli) | 4/4 hijau, zero console error/pageerror |
| Regresi E2E Task 2 | 8/8 hijau (dashboard disentuh: tambah link Pengaturan) |
| `next build --webpack` | sukses, zero error |
| `pnpm lint` | bersih |

## Yang dibangun

**Halaman `/settings`** (terproteksi, link "Pengaturan" dari `/dashboard`):
- Section *Provider AI*: 4 slot (Chat, Embedding, Vision, Transkripsi). Tiap slot:
  nama, base URL, API key (password), model (dropdown), toggle Aktif.
  Slot non-Chat punya checkbox "Sama dengan Chat" — bila aktif, field slot itu
  disabled dan mengikuti konfigurasi slot Chat.
- Section *Umum*: nama persona (default "Reza"), gaya bahasa
  (santai/profesional santai/formal), nomor WA owner (default 082114812842),
  mode AI global (penuh/semi/mati), jam follow up mulai–selesai (default 08.00–20.00 WIB).
- Tiap slot punya tombol "Deteksi model" (isi dropdown dari `GET {baseUrl}/models`)
  dan "Tes koneksi" (uji sungguhan per slot + latensi). Pesan galat Bahasa Indonesia.

**API** (semua `requireAdmin`):
- `GET /api/settings` — API key tidak pernah dikirim utuh: hanya
  `apiKeyMasked: "••••" + 4 digit terakhir` + `keySet: true/false`.
- `PUT /api/settings` — API key baru dienkripsi (AES-256-GCM) ke tabel Setting;
  key lama dipertahankan bila field dikosongkan.
- `POST /api/providers/detect` — `GET {baseUrl}/models`, parse format OpenAI
  `{data:[{id}]}`. Bila apiKey dikosongkan, pakai key tersimpan.
- `POST /api/providers/test` — chat: `POST /chat/completions` (ping);
  embedding: `POST /embeddings`; vision: `POST /chat/completions`;
  transkripsi: `GET /models` (endpoint transkripsi butuh berkas audio, jadi yang
  diuji konektivitas + auth-nya). Timeout 15 detik, galat dipetakan ke Bahasa Indonesia.

**Penyimpanan** (tidak ada migrasi baru — memakai tabel Fase 1 yang sudah ada):
- `Setting` `provider.apikey.<slot>` — API key terenkripsi AES-256-GCM (MASTER_KEY).
- `Setting` `provider.inherit.<slot>` — `"1"`/`"0"` (flag "Sama dengan Chat").
- `Setting` `general.personaName`, `general.personaTone`, `general.ownerWaNumber`,
  `general.aiMode`, `general.followupStart`, `general.followupEnd` — terenkripsi seragam.
- `Provider` — satu baris per slot: name, baseUrl, model, enabled;
  `apiKeySettingKey` menunjuk ke key Setting di atas.

**Helper untuk Task 4** (`packages/core/src/providers.ts`, diekspor dari `@reza-ai/core`):
- `getEffectiveProviderConfig(slot)` — config efektif per slot: sudah termasuk
  resolusi inherit + dekripsi API key. Worker Task 4 memakai ini, bukan baca tabel langsung.
- `getGeneralSettings()`, `listProviderSummaries()` (masked, untuk UI),
  `saveProviderSlot()`, `saveGeneralSettings()`, `maskApiKey()`, `parseModelList()`.

## Cara reproduksi E2E

```bash
# 1. Reset database E2E (PGlite di apps/web/data/e2e)
#    Catatan: script "e2e:reset-db" di package.json diperbaiki di task ini
#    (sebelumnya terpotong/tidak valid). Ekuivalen manual:
cd apps/web && rm -rf ./data/e2e
(cd ../../packages/core && DATABASE_URL=pglite://../../apps/web/data/e2e node scripts/pglite-migrate.mjs)

# 2. Jalankan server production dengan backend E2E
export DATABASE_URL="pglite://$HOME/workspace/reza-ai/apps/web/data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
npx next start -p 3100

# 3. Jalankan Playwright (butuh chromium di ~/.cache/ms-playwright, lihat demo-task-2.md)
npx playwright test settings.spec.ts
```

File spec ini mandiri (membuat adminnya sendiri) dan memakai DB fresh;
jangan digabung satu run paralel dengan `auth.spec.ts` (keduanya butuh DB kosong).

## Skenario E2E (e2e/settings.spec.ts)

Mock provider OpenAI-compatible jalan di dalam test (Node `http`,
`127.0.0.1`, port acak): `GET /v1/models` -> 2 model, `POST /v1/chat/completions`
-> "pong" (menuntut `Authorization: Bearer` yang tepat, 401 bila salah),
`POST /v1/embeddings` -> vektor dummy.

1. **Setup** — wizard `/setup` membuat admin khusus file ini.
2. **Alur settings lengkap** — login 2 langkah -> klik "Pengaturan" di dashboard ->
   isi slot Chat (nama, base URL mock, API key `sk-e2e-secret-key-12345`) ->
   "Deteksi model" -> "Ketemu 2 model" -> pilih `mock-chat-model` ->
   "Tes koneksi" -> "Koneksi berhasil (N ms)" -> centang "Sama dengan Chat" di
   slot Embedding (field-nya disabled) -> ubah nama persona/gaya bahasa ->
   "Simpan pengaturan" -> "Pengaturan tersimpan." -> reload ->
   base URL/nama/model/persona/inherit tampil persis, key tampil sebagai
   `••••2345` (field kosong) -> `GET /api/settings` via fetch browser:
   respons tidak mengandung key utuh (assert string), `apiKeyMasked` benar,
   tidak ada field `apiKey`/`encryptedValue`, `inherit: true` untuk embedding ->
   simpan ulang dengan field key kosong -> key lama tetap tersimpan ->
   "Tes koneksi" dengan field kosong tetap berhasil (fallback memakai key
   tersimpan — mock memverifikasi header Authorization asli).
3. **Proteksi** — `GET /api/settings` dan `POST /api/providers/detect` tanpa
   sesi -> 401.
4. **Zero console error/pageerror** — tidak ada `pageerror`; `console.error`
   difilter pola 401 yang disengaja seperti di auth.spec.ts (tidak terpicu di sini).

## Batasan yang diakui jujur

- Sama seperti Task 2: E2E memakai PGlite + Redis in-memory (`memory://`),
  bukan service asli. Di VPS pakai PostgreSQL + Redis asli.
- `detect`/`test` dijalankan server-side oleh Next.js; timeout 15 detik.
- Dropdown model hanya terisi setelah "Deteksi model" diklik (atau dari nilai
  tersimpan) — tidak ada auto-detect saat halaman dibuka, supaya tidak ada
  request keluar tanpa aksi admin.
- Flag inherit disimpan sebagai Setting `"1"`/`"0"` (bukan kolom baru di
  `Provider`) agar tidak menambah migrasi di tengah Fase 1.
