# Demo Task 6 — Knowledge base (teks, URL, PDF) + hybrid retrieval

Tanggal: 2026-10-07. Semua bukti direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + ekstensi vector + Redis in-memory), bukan mock UI.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 112/112 hijau (12 file; 26 test baru Task 6) |
| Unit test `apps/web` | 50/50 hijau (5 file; tidak ada perubahan perilaku) |
| E2E Playwright `knowledge.spec.ts` (chromium asli) | 9/9 hijau, zero console error/pageerror |
| Build | core + worker + web (`next build --webpack`) sukses, lint bersih |
| Worker boot | `tsx src/index.ts` — 8 antrian terdaftar, `ingest` + `reindex` aktif, tanpa crash |

## Yang dibangun

**Core (`packages/core/src/knowledge.ts`, baru):**
- `chunkText(title, section, text)` — chunk ~512 token (estimasi 1 token ≈ 4
  karakter, didokumentasikan di konstanta `CHARS_PER_TOKEN`), overlap ~64 token
  yang selalu berhenti di batas kalimat; tiap chunk diawali prefix kontekstual
  `Judul: <title>\nBagian: <section>\n\n`. Tanpa tokenizer native.
- `splitSections` — section dari heading markdown (`#`/`##`/…).
- Ekstraktor: teks langsung; URL → fetch (timeout 15 dtk, tolak non-HTML,
  batas 2MB) + Readability (`@mozilla/readability` + `linkedom`, jalan di
  Node 24); PDF → `unpdf` (murni JS). Semua kegagalan melempar Error dengan
  pesan yang jelas → item ditandai `failed` + `errorMessage`.
- `embedBatch(texts, cfg)` — `POST {baseUrl}/embeddings {model, input}`,
  batch 32/request, urutan respons dijamin via field `index`.
- `ingestKnowledgeItem(itemId, deps)` — extract → chunk → embed → tulis atomik
  (hapus chunk lama + sisip baru dalam satu transaksi = idempoten) → status
  `ready`/`failed`. Dependensi di-inject (pola Task 5): dipakai worker,
  harness E2E, dan unit test.
- `hybridSearch(query, deps, {topK=6})` — (a) embed query; (b) 3×topK kandidat
  vector via `ORDER BY embedding <=> $1` (index HNSW, cosine); (c) 3×topK
  kandidat full-text via `tsv @@ plainto_tsquery('simple', $query)` (index GIN;
  kamus `simple` karena Postgres tak punya kamus Indonesia); (d) gabung via
  `rrfFuse` (Reciprocal Rank Fusion, k=60); (e) top-K
  `{chunk, score, source: 'vector'|'fts'|'both', itemTitle}`. Query mentah via
  Prisma `$queryRaw`. Filter: hanya `status='ready'` dan
  `validUntil IS NULL OR validUntil > NOW()`.
- `reindexAll(cfg, deps)` — probe 1 embedding untuk deteksi dimensi; bila beda
  dari dimensi kolom: `DROP INDEX` → `ALTER COLUMN … TYPE vector(n) USING NULL`
  → `CREATE INDEX` HNSW ulang; lalu embed ulang SEMUA chunk (batch 32);
  dimensi aktif dicatat di Setting `knowledge.embeddingDim`.
- Antrean: `enqueueKnowledgeIngest` (reuse antrean BullMQ `ingest` + list
  fallback `reza:ingest:fallback`, payload `{kind:"knowledge-item", itemId}`,
  jobId `knowledge-<id>` untuk dedup); `enqueueReindex` (antrean `reindex` —
  sudah ada di `QUEUE_NAMES` — + list `reza:reindex:fallback`,
  jobId `reindex-embeddings`); `startReindexFallbackPoller`;
  `maybeEnqueueReindex(redis, oldModel, newModel)` (hook ganti model).
- `getActiveEmbeddingDim()` untuk UI.
- `FACT_SHEET_TEMPLATE` di `@reza-ai/core/client` (murni, aman di-bundle
  browser) untuk tombol template di form.

**Skema (Prisma):** `KnowledgeItem` += `content` (teks mentah),
`data` (base64 berkas PDF — **TEXT, bukan BYTEA**: driver adapter PGlite
merusak nilai Bytes biner, terbukti empiris; migrasi
`20261007070000_knowledge_data_text`), `errorMessage`. PDF disimpan di DB
(tidak ada file sementara) supaya worker & web tidak bergantung filesystem
yang sama. Migrasi SQL manual seperti pola `*_search`.

**Worker (`apps/worker/src/index.ts`):** prosesor `ingest` bercabang —
payload `kind:"knowledge-item"` → `ingestKnowledgeItem`, sisanya tetap
`processInboundMessage`; prosesor `reindex` → resolve config embedding lalu
`reindexAll`; poller fallback ingest (dengan handler knowledge) + reindex
dijalankan; keduanya di-stop saat shutdown.

**Web (`apps/web/`):**
- Halaman `/knowledge` (link dari dashboard, `requireAdminPage`):
  daftar item (badge Memproses/Siap/Gagal, kategori, jumlah chunk,
  `validUntil` dengan peringatan Kedaluwarsa/≤30 hari), form tambah
  Teks (tombol template fact sheet) / URL / PDF (multipart, maks 10MB),
  hapus dengan konfirmasi, detail item + daftar chunk (klik Detail),
  panel **Tes Pencarian** (query → chunk + skor RRF + badge sumber
  Vektor/Teks/Keduanya + judul sumber), tombol **Indeks ulang embeddings**,
  banner peringatan bila slot embedding belum dikonfigurasi.
  Status "Memproses" ter-update via polling ringan 2,5 dtk (data dari DB —
  UI tidak pernah pura-pura sukses).
- API: `GET/POST /api/knowledge/items`, `GET/DELETE /api/knowledge/items/[id]`,
  `POST /api/knowledge/search`, `GET/POST /api/knowledge/reindex`.
  Semua butuh sesi admin (401 tanpa sesi, pola yang sama dengan route lain).
- Hook `PUT /api/settings`: bandingkan model embedding lama vs baru →
  bila beda, `enqueueReindex` (respons: `{ok:true, reindexEnqueued}`).
- Harness E2E `src/lib/knowledge-harness.ts` + route test-only
  `/api/test/knowledge/harness` dan `/api/test/knowledge/mock-embedding`
  (aktif hanya bila `E2E_TEST_API=1`).

## Cara reproduksi E2E

```bash
cd apps/web
pnpm e2e:reset-db          # hapus data E2E + terapkan 4 migrasi ke PGlite
# stop server lama bila ada, lalu:
export DATABASE_URL="pglite://$HOME/workspace/reza-ai/apps/web/data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
export E2E_TEST_API=1
npx next start -p 3100
npx playwright test knowledge.spec.ts   # DB harus fresh; satu file per run
```

Catatan urutan: reset DB dulu, BARU start server (jangan reset saat server
jalan — PGlite yang sudah terbuka bisa tetap melihat data lama; ini
keterbatasan E2E sandbox, bukan bug aplikasi).

## Skenario E2E (e2e/knowledge.spec.ts)

1. **Setup + login** — admin via wizard `/setup`.
2. **Harness + mock embedding** — `POST /api/test/knowledge/harness`
   (poller ingest+reindex in-process, fungsi produksi) +
   `/api/test/knowledge/mock-embedding` (slot embedding → server mock lokal).
3. **Navigasi** — dashboard → link "Basis Pengetahuan" → `/knowledge`;
   tanpa banner peringatan embedding; daftar kosong.
4. **Tambah TEKS via UI** — klik "Pakai template Fact Sheet Proyek"
   (textarea terisi template) → isi konten fiktif "Perumahan Contoh" →
   Simpan → status "Siap" via polling (job ingest nyata: extract → chunk →
   embed → PGlite), jumlah chunk tampil.
5. **Tes Pencarian** — query "kolam renang anak" → chunk relevan muncul
   dengan judul sumber + skor + badge sumber (hasil hybrid asli).
6. **Kedaluwarsa** — tambah item dengan validUntil kemarin → "Siap" +
   badge "Kedaluwarsa" di daftar → cari "kolam renang" → item kedaluwarsa
   TIDAK muncul di hasil.
7. **Upload PDF via UI** — PDF minimal dibuat programatik di spec →
   `setInputFiles` → "Siap" (unpdf di server) → konten PDF bisa dicari.
8. **Hapus** — konfirmasi dialog → item hilang dari daftar
   (chunk ikut terhapus via cascade).
9. **Zero console error/pageerror.**

## Kejujuran simulasi

- Yang **disimulasikan**: HANYA provider embedding-nya (server HTTP lokal di
  file spec: `POST /embeddings` mengembalikan vektor hash deterministik per
  kata — FNV-1a per token → indeks `hash % 1536`; teks berbagi kosakata →
  cosine similarity tinggi; mock menuntut `Authorization: Bearer e2e-test-key`
  untuk membuktikan API key terenkripsi mengalir dengan benar) dan transport
  antreannya (list fallback, bukan BullMQ — BullMQ butuh skrip Lua Redis asli).
- Yang **real**: `POST /api/knowledge/items` → `enqueueKnowledgeIngest` →
  poller → `ingestKnowledgeItem` (chunkText, embedBatch via HTTP ke mock,
  insert vector + tsv) → PGlite; `POST /api/knowledge/search` →
  `hybridSearch` (query `$queryRaw` vector `<=>` + `@@` FTS + RRF di kode
  produksi); `unpdf` + Readability; seluruh render & polling UI.
- **Tidak ada seed data knowledge** — sesuai permintaan, data uji dibuat
  dan dihapus di dalam skenario (DB E2E di-reset tiap run).

## Keputusan desain

- **Reuse antrean `ingest` untuk knowledge** (bukan antrean baru):
  payload discriminator `kind:"knowledge-item"`; poller fallback yang sama
  bercabang di satu tempat. Worker BullMQ pun bercabang di handler `ingest`.
  Antrean `reindex` yang sudah didaftarkan di `QUEUE_NAMES` sejak awal kini
  dipakai betulan.
- **Chunking tanpa tokenizer native**: 1 token ≈ 4 karakter (konservatif
  untuk Indonesia/Inggris); kalimat raksasa dipotong per kata; overlap
  selalu di batas kalimat. Prefix kontekstual per chunk membantu retrieval
  lintas-chunk.
- **RRF k=60** (nilai standar literatur) — menggabungkan ranking vector &
  FTS tanpa perlu menormalkan skor yang skalanya beda.
- **`validUntil` sebagai filter keras di SQL**, bukan di aplikasi — item
  promo kedaluwarsa tidak akan pernah dikutip AI.
- **PDF sebagai base64 TEXT**: BYTEA terbukti rusak oleh driver adapter
  PGlite (`expected a string or an array in column 'data'` — diverifikasi
  empiris untuk Buffer maupun Uint8Array); base64 aman di semua operasi
  Prisma, overhead +33% dapat diterima untuk PDF ≤10MB.
- **Reindex otomatis saat ganti model** via hook `PUT /api/settings`
  (`maybeEnqueueReindex` — pure, ter-unit-test) karena vektor model lama
  tidak kompatibel dengan model baru; dimensi dideteksi dari probe, bukan
  dari nama model.
- **UI polling, bukan SSE**: status ingest cukup di-refresh 2,5 dtk selama
  ada yang "Memproses" — lebih simpel dari SSE dan tetap real (dari DB).

## Hook untuk Task 7 (AI reply engine)

```ts
import { hybridSearch, type HybridSearchHit } from "@reza-ai/core";

const hits: HybridSearchHit[] = await hybridSearch(
  pertanyaanPelanggan,
  knowledgeDeps,   // { prisma, redis, getEmbeddingConfig }
  { topK: 6 },     // default 6
);
// hits[i] = {
//   chunkId, itemId, chunkIndex,
//   title,            // judul item saat chunk dibuat
//   section,          // nama section (heading) | null
//   content,          // SUDAH diawali "Judul: …\nBagian: …\n\n"
//   itemTitle,        // judul KnowledgeItem (untuk sitasi)
//   score,            // skor RRF (relatif, bukan probabilitas)
//   source,           // 'vector' | 'fts' | 'both'
// }
```

- `content` siap ditempel ke prompt sebagai konteks (sudah ada prefix
  judul+bagian). `itemTitle` untuk sitasi ke pelanggan bila perlu.
- `hybridSearch` melempar bila slot embedding belum dikonfigurasi/aktif —
  tangkap dan fallback ke "pengetahuan belum tersedia".
- Item kedaluwarsa & belum ready sudah disaring di SQL — tidak perlu
  filter ulang.
- Butuh embedding untuk pertanyaan pelanggan: `embedBatch([q], cfg)`
  tersedia bila Task 7 perlu kemiripan langsung (mis. ExamplePair).
- Dimensi embedding aktif: `getActiveEmbeddingDim()` (dari Setting
  `knowledge.embeddingDim`, default 1536).
