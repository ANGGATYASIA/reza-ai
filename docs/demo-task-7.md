# Demo Task 7 — AI Reply Engine + Playground

Tanggal: 2026-10-07. Semua bukti direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + ekstensi vector + Redis in-memory), bukan mock UI.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 133/133 hijau (13 file; 21 test baru Task 7) |
| Unit test `apps/web` | 50/50 hijau (5 file; tidak ada perubahan perilaku) |
| E2E Playwright `playground.spec.ts` (chromium asli) | 6/6 hijau, zero console error/pageerror |
| Build | core (`tsc`) + web (`next build --webpack`) sukses, lint bersih |
| Proteksi | `/playground` tanpa sesi -> 307 ke `/login`; API tanpa sesi -> 401 |

## Yang dibangun

**Core (`packages/core/src/ai-engine.ts`, baru; diekspor dari `@reza-ai/core`):**
- `detectSensitiveIntent(text)` — murni, tanpa I/O. Pola keyword Bahasa
  Indonesia (case-insensitive), dicek berurutan:
  - **negosiasi**: `\bdiskon\b|nego|potongan harga|kurang(in)? harga|best price|turun(in)? harga`
  - **survei**: `\bsurvei\b|survey|lihat (lokasi|unit)|jadwal kunjung|site visit`
  - **legal** (dicek SEBELUM komplain supaya "lapor polisi" jadi legal):
    `somasi|pengacara|hukum|polisi`
  - **komplain**: `komplain|kecewa|tipu|menipu|ditipu|lapor`
  
  Tiap pola membawa `reason` Bahasa Indonesia yang dipakai sebagai alasan
  handoff. Ter-unit-test per intent (15 kasus).
- `buildReplyPrompt({persona, history, chunks})` — satu system message:
  - (a) identitas: `{name}` (default "Reza"), marketing Grand Duta City
    South of Jakarta (Parung, Bogor), membalas chat WhatsApp calon pembeli;
  - (b) kunci suara eksplisit (slang-id INTENSITAS RENDAH, profesional
    santai): sapaan saya-kamu ("kamu"; JANGAN "Anda"/"Saudara"), partikel
    sih/kok sesekali, TANPA EMOJI sama sekali, tidak pernah mengaku AI
    (tetap dalam peran sebagai Reza), pantangan hiruk pikuk / krusial /
    em dash / paralelisme "bukan hanya X tetapi juga Y" / pembuka klise /
    penutup ritual; spesifik di kalimat pertama; 1 ide 1 kalimat pendek;
  - (c) guardrail: JANGAN PERNAH menjanjikan diskon/harga final/jadwal
    survei pasti; HANYA fakta dari KONTEKS PENGETAHUAN (sitasi internal
    `[1]`, `[2]` per fakta — internal, tidak ditulis di balasan); kalau
    tidak ada di konteks: katakan belum punya infonya, arahkan tanya
    langsung ke Reza, JANGAN mengarang; balasan maks 3 kalimat gaya chat;
  - (d) riwayat 10 pesan terakhir (`PROMPT_HISTORY_LIMIT`) format
    "Lead: …" / "{name}: …";
  - (e) chunk bernomor `[1..k]` dari `content` (sudah berprefix
    Judul/Bagian) + `(Sumber: itemTitle)`.
  
  Model diminta mengeluarkan HANYA JSON:
  `{"reply","confidence":0-1,"handoff","reason","sourcesUsed":[n]}`.
- `generateReply(input, deps)` — TIDAK PERNAH melempar:
  1. `hybridSearch` asli (retrieval Task 6);
  2. gerbang sufficiency tanpa LLM: intent sensitif -> handoff + reason
     pola; 0 chunk -> handoff "Pertanyaan di luar knowledge yang tersedia";
  3. config chat (`getChatConfig`) -> `POST {baseUrl}/chat/completions`
     `{model, temperature: 0.2, response_format: {type:"json_object"}}`,
     timeout 60 dtk;
  4. validasi Zod `{reply: string, confidence: 0-1, handoff: boolean,
     reason: string|null, sourcesUsed: number[]}`; `sourcesUsed`
     di-clamp ke nomor chunk valid, di-dedupe, diurutkan;
  5. fallback: JSON rusak -> coba ekstrak substring `{…}` -> masih gagal
     -> handoff `{reason: "Respon AI tidak valid, diteruskan ke Reza"}`;
     kegagalan lain (embedding belum dikonfigurasi, chat HTTP error,
     timeout) -> handoff dengan pesan yang jelas.
  
  Hasil: `{reply, confidence, handoff, reason, sourcesUsed, sources:
  [{index, itemTitle}]}`. `sources` dibangun lokal (bukan dari LLM) untuk
  ditampilkan di UI.
- Util: `parseLlmReply`, `extractJsonObject` (diekspor untuk test).

**Web (`apps/web/`):**
- Halaman `/playground` (link "Playground AI" dari dashboard,
  `requireAdminPage`): `PlaygroundClient` — area chat di mana admin
  berperan sebagai lead. Tiap balasan Reza menampilkan badge
  "Keyakinan N%", daftar sumber (`[n] itemTitle` yang dikutip), dan bila
  `handoff` -> banner "Diteruskan ke Reza — \<reason\>". Loading state
  ("…sedang mengetik…"), error state (banner merah), riwayat per sesi
  halaman (state komponen).
- API `POST /api/playground/chat` `{messages: [{role, text}]}` (pesan
  terakhir harus dari lead): validasi -> cek slot chat eksplisit
  (**400 + pesan jelas** bila belum dikonfigurasi — UI tidak diam) ->
  `generateReply` asli dengan persona dari Pengaturan umum
  (`personaName`, `personaTone`) -> JSON `{reply, confidence, handoff,
  reason, sourcesUsed, sources}`.
- Route test-only (aktif hanya `E2E_TEST_API=1`):
  `POST /api/test/playground/mock-chat` (arahkan slot chat ke mock via
  `saveProviderSlot` produksi) dan `POST /api/test/playground/seed`
  (buat + ingest sinkron item "Daftar Harga Tipe Verona — DATA UJI
  (fiktif)" via `ingestKnowledgeItem` produksi).

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
npx playwright test playground.spec.ts   # DB harus fresh; satu file per run
```

Catatan urutan: reset DB dulu, BARU start server (pola yang sama dengan
Task 6 — jangan reset saat server jalan).

## Skenario E2E (e2e/playground.spec.ts)

1. **Setup + login** — admin via wizard `/setup`.
2. **Provider mock** — slot embedding -> server mock lokal (hash
   deterministik, menuntut `Bearer e2e-test-key`); slot chat -> server
   mock lokal (OpenAI-compatible `/chat/completions`, menuntut `Bearer
   e2e-chat-key` — membuktikan API key terenkripsi mengalir dengan benar);
   lalu `POST /api/test/playground/seed` (ingest nyata: extract -> chunk
   -> embed -> PGlite, 1 chunk).
3. **Navigasi** — dashboard -> link "Playground AI" -> `/playground`.
4. **Tanya harga** — kirim "Harga tipe Verona berapa?" -> balasan tampil
   ("…Rp950 juta…"), badge "Keyakinan 90%", daftar sumber menampilkan
   "Daftar Harga Tipe Verona", tidak ada banner handoff.
   Jalur: `POST /api/playground/chat` -> `generateReply` (hybridSearch
   asli -> chunk ketemu -> chat completions via fetch produksi ke mock
   -> Zod valid).
5. **Tanya diskon** — kirim "Bisa diskon 10%?" -> banner "Diteruskan ke
   Reza — Negosiasi harga/diskon — perlu persetujuan Reza langsung".
   Jalur: gerbang `detectSensitiveIntent` handoff TANPA memanggil LLM
   (terbukti di unit test via penghitung `chatCalls`).
6. **Zero console error/pageerror.**

## Kejujuran simulasi

- Yang **disimulasikan**: provider embedding (server HTTP mock lokal,
  vektor hash deterministik per kata — pola Task 6), provider chat
  (server HTTP mock lokal, JSON canned: harga -> `{reply, confidence:
  0.9, handoff: false, sourcesUsed: [1]}`; diskon -> handoff), transport
  antrean (tidak dipakai di Task 7 — ingest seed sinkron), dan DATA
  knowledge-nya: item "Daftar Harga Tipe Verona — DATA UJI (fiktif)"
  berisi **harga fiktif Rp950 juta** — judul dan isi selalu memuat
  penanda "DATA UJI (fiktif)", bukan harga Grand Duta City sungguhan.
- Yang **real**: `generateReply` seluruhnya — `hybridSearch` (query
  `$queryRaw` vector `<=>` + `@@` FTS + RRF), `detectSensitiveIntent`,
  `buildReplyPrompt`, `fetch` chat completions, parsing + validasi Zod,
  seluruh fallback; `POST /api/playground/chat` (auth, validasi, cek
  config chat); render badge/sumber/banner di UI.
- **Tidak ada seed data knowledge produksi** — sesuai permintaan, data
  uji dibuat dan ditandai fiktif di dalam skenario (DB E2E di-reset tiap
  run).

## Keputusan desain

- **Gerbang intent sebelum LLM, setelah retrieval**: urutan
  negosiasi -> survei -> legal -> komplain disengaja — "lapor polisi"
  harus jadi legal, bukan komplain. Gerbang ini tanpa LLM: cepat,
  deterministik, dan tidak menghabiskan token untuk pertanyaan yang
  jawabannya selalu sama (diteruskan ke manusia).
- **0 chunk -> handoff, bukan jawaban bebas**: model dilarang memakai
  pengetahuan di luar konteks; kalau retrieval kosong, satu-satunya
  jawaban jujur adalah meneruskan ke Reza.
- **`generateReply` tidak pernah melempar**: Task 8 (wiring WhatsApp)
  memanggilnya di jalur pesan masuk — throw di sana berarti pesan
  hilang diam-diam. Setiap kegagalan menjadi handoff yang tercatat.
- **Sitasi `[n]` internal**: model wajib menandai fakta dengan nomor
  konteks agar jawabannya bisa diaudit, tapi sitasi tidak dikirim ke
  lead (balasan WhatsApp tetap natural). `sourcesUsed` di-clamp ke
  indeks valid karena LLM kadang mengarang nomor.
- **Temperature 0.2 + `response_format: json_object`**: balasan
  grounded butuh determinisme; JSON mode mengurangi (tidak
  menghilangkan — makanya ada fallback) respons non-JSON.
- **Persona dari Pengaturan umum**: nama & gaya bahasa yang admin atur
  di Pengaturan otomatis dipakai prompt — tidak ada hardcode "Reza"
  di luar default.
- **UI playground jujur soal provider**: bila slot chat belum
  dikonfigurasi, API mengembalikan 400 dengan pesan yang jelas dan UI
  menampilkan error state — tidak ada balasan palsu.

## Hook untuk Task 8 (wiring WhatsApp)

```ts
import { generateReply, type GenerateReplyResult } from "@reza-ai/core";

const result: GenerateReplyResult = await generateReply(
  {
    message: pesanLeadTerbaru,          // string
    history: riwayatChat,               // [{role: "lead"|"reza", text}]
    persona: { name: "Reza", tone: "profesional-santai" }, // opsional; default ini
    topK: 6,                            // opsional
  },
  {
    prisma,                             // PrismaClient singleton
    redis,                              // Redis (asli / mock)
    getChatConfig: () => getEffectiveProviderConfig("chat"),
    getEmbeddingConfig: () => getEffectiveProviderConfig("embedding"),
    // fetchImpl opsional (default: global fetch)
  },
);
// result = {
//   reply: string,            // teks balasan WhatsApp ("" bila handoff)
//   confidence: number,       // 0-1
//   handoff: boolean,
//   reason: string | null,    // alasan handoff (Bahasa Indonesia)
//   sourcesUsed: number[],    // nomor chunk 1-based
//   sources: [{ index, itemTitle }],  // untuk sitasi/audit
// }
```

Pemetaan yang disarankan untuk Task 8:
- `handoff === true` -> buat baris `Handoff` (alasan = `result.reason`,
  konteks = pesan lead + `sources`) + notifikasi ke nomor owner
  (`ownerWaNumber` dari `getGeneralSettings()`).
- `handoff === false` + mode AI `semi` -> buat `Draft` (isi =
  `result.reply`, `confidence`, `sources`) untuk di-approve reja.
- `handoff === false` + mode AI `full` -> `enqueueSend` dengan
  `result.reply`.
- `confidence` rendah (mis. < 0.5) bisa jadi pemicu handoff juga —
  keputusannya di Task 8, engine hanya melaporkan angkanya.
- Jangan panggil `generateReply` untuk pesan yang `shouldIgnoreChat`
  (grup/status/internal) — itu ranah Task 5, bukan engine.
