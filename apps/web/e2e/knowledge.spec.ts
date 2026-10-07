import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 6 — knowledge base: UI sinkron dengan backend ASLI.
 *
 * Arsitektur yang diuji:
 *   UI /knowledge -> POST /api/knowledge/items (REAL)
 *        -> enqueueKnowledgeIngest (kode produksi @reza-ai/core)
 *        -> poller 250ms (harness in-process) -> ingestKnowledgeItem REAL
 *           (extract -> chunkText -> embedBatch -> PGlite)
 *        -> polling UI -> status "Siap" dari DB
 *   panel Tes Pencarian -> POST /api/knowledge/search -> hybridSearch REAL
 *        (vector HNSW + FTS GIN + RRF) -> chunk + skor + sumber
 *
 * JUJUR: yang disimulasikan HANYA provider embedding-nya (server HTTP
 * mock lokal di file ini — OpenAI-compatible POST /embeddings dengan
 * vektor hash deterministik per kata, cukup untuk relevansi; seluruh
 * jalur getEffectiveProviderConfig -> embedBatch -> POST /embeddings
 * adalah kode produksi) dan transport antreannya (list fallback, bukan
 * BullMQ — BullMQ butuh skrip Lua Redis asli; pola yang sama dengan
 * Task 4/5). Worker tidak jalan sebagai proses terpisah karena
 * REDIS_URL=memory:// tidak lintas-proses dan PGlite tidak boleh
 * dibuka dua proses (lihat docs/demo-task-6.md).
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-6.md),
 * termasuk E2E_TEST_API=1.
 * Jalankan sendiri:  npx playwright test knowledge.spec.ts
 */

const ADMIN_EMAIL = "e2e-knowledge@reza-ai.test";
const ADMIN_PASSWORD = "Katasandi!E2EKnowledge9";
const E2E_API_KEY = "e2e-test-key";
const EMBED_DIM = 1536;

const consoleErrors: string[] = [];

// FNV-1a per kata -> vektor deterministik (mock embedding).
function hashVec(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % dim] += 1;
  }
  return vec;
}

let mockServer: Server;
let mockPort = 0;

function startMockEmbedding(): Promise<number> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/embeddings") {
        // Mock menuntut Authorization yang benar — membuktikan server
        // benar-benar mengirim API key dari settings terenkripsi.
        if (req.headers.authorization !== `Bearer ${E2E_API_KEY}`) {
          json(401, { error: { message: "Incorrect API key provided" } });
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw) as { input: string[] };
          json(200, {
            data: body.input.map((t, i) => ({
              embedding: hashVec(t, EMBED_DIM),
              index: i,
            })),
          });
        });
      } else {
        json(404, { error: "not found" });
      }
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve(mockPort);
    });
  });
}

// PDF minimal yang valid untuk unpdf (xref dihitung programatik).
function buildMinimalPdf(text: string): Buffer {
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET`;
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function watchConsole(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
}

function totpNow(secret: string): string {
  return generateSync({ secret });
}

/** Panggil API test-only lewat browser (cookie sesi ikut terkirim). */
async function testApi(
  page: Page,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, body }: { path: string; body?: unknown }) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, data };
    },
    { path, body },
  );
}

const FACT_TEXT = `# Perumahan Contoh

## Ringkasan
Perumahan Contoh adalah cluster fiktif untuk pengujian otomatis. Dikembangkan oleh PT Contoh Properti. Total 200 unit di atas lahan 5 hektar.

## Tipe Unit
- Tipe 36/72 — 2 kamar tidur, 1 kamar mandi — harga mulai Rp800 juta
- Tipe 45/90 — 3 kamar tidur, 2 kamar mandi — harga mulai Rp1,1 miliar

## Harga & Promo
- Harga mulai Rp800 juta (belum termasuk PPN & biaya KPR).
- Promo: gratis biaya AJB untuk 10 pembeli pertama.

## Fasilitas Kawasan
- Kolam renang anak dan dewasa, clubhouse, taman bermain.
- Masjid, ruko komersial, one-gate system dengan CCTV.

## Akses & Lokasi
- 10 menit ke tol Contoh.
- 15 menit ke stasiun Contoh.

## Cara Beli & Kontak
- Booking fee Rp5 juta.
- Hubungi WhatsApp 080000000000 untuk survei lokasi.
`;

test.describe.serial("Task 6 — /knowledge: UI sinkron backend", () => {
  let totpSecret = "";

  test.beforeAll(async () => {
    await startMockEmbedding();
  });

  test.afterAll(async () => {
    mockServer.close();
  });

  async function login(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.getByLabel("Kode verifikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  }

  test("1. /setup: buat admin untuk file ini", async ({ page }) => {
    watchConsole(page);
    await page.goto("/setup");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Lanjut" }).click();

    await expect(page.getByAltText("Kode QR TOTP")).toBeVisible({ timeout: 15000 });
    totpSecret = await page.locator("#secret").inputValue();

    await page.getByLabel("Kode 6 digit dari aplikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Aktifkan dan selesai" }).click();
    await expect(page.getByText("Penyiapan selesai")).toBeVisible({ timeout: 15000 });
  });

  test("2. harness + arahkan slot embedding ke mock", async ({ page }) => {
    await login(page);

    const h = await testApi(page, "/api/test/knowledge/harness");
    expect(h.status, `harness gagal: ${JSON.stringify(h.data)}`).toBe(200);

    const m = await testApi(page, "/api/test/knowledge/mock-embedding", {
      baseUrl: `http://127.0.0.1:${mockPort}`,
      apiKey: E2E_API_KEY,
      model: "mock-embed-1536",
    });
    expect(m.status, `mock-embedding gagal: ${JSON.stringify(m.data)}`).toBe(200);
  });

  test("3. dashboard -> /knowledge, tanpa peringatan embedding", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Basis Pengetahuan" }).click();
    await expect(page).toHaveURL(/\/knowledge/);
    await expect(page.getByRole("heading", { name: "Basis Pengetahuan" })).toBeVisible();
    await expect(page.getByText("Slot embedding belum dikonfigurasi")).not.toBeVisible();
    await expect(page.getByText("Belum ada sumber.")).toBeVisible();
  });

  test("4. tambah item TEKS via UI (template fact sheet) -> status Siap", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/knowledge");
    await expect(page.getByText("Belum ada sumber.")).toBeVisible();

    await page.getByLabel("Judul").fill("Fact Sheet Perumahan Contoh");
    await page.getByRole("button", { name: "Pakai template Fact Sheet Proyek" }).click();
    // Template terisi di textarea…
    await expect(page.getByLabel("Konten teks")).toHaveValue(/\[NAMA PROYEK\]/);
    // …lalu diisi konten fiktif untuk pengujian.
    await page.getByLabel("Konten teks").fill(FACT_TEXT);
    await page.getByLabel("Kategori (opsional)").fill("fact-sheet");
    await page.getByRole("button", { name: "Simpan & proses" }).click();

    await expect(page.getByText("Tersimpan — diproses di latar.")).toBeVisible();
    // Status diambil dari DB via polling: Memproses -> Siap.
    const row = page.locator("section[aria-label='Daftar sumber'] > div", {
      hasText: "Fact Sheet Perumahan Contoh",
    });
    await expect(row.getByText("Siap")).toBeVisible({ timeout: 60000 });
    // Fact sheet punya 6 section -> beberapa chunk, bukan 1.
    await expect(row.getByText(/\d+ chunk/)).toBeVisible();
  });

  test("5. panel Tes Pencarian -> chunk relevan + skor + sumber", async ({ page }) => {
    await login(page);
    await page.goto("/knowledge");

    await page.getByLabel("Query pencarian").fill("kolam renang anak");
    await page.getByRole("button", { name: "Cari" }).click();

    const panel = page.locator("section[aria-label='Tes pencarian']");
    await expect(
      panel.getByText("Fact Sheet Perumahan Contoh").first(),
    ).toBeVisible({ timeout: 30000 });
    // Skor + badge sumber tampil (hasil hybrid asli).
    await expect(panel.getByText(/skor /).first()).toBeVisible();
  });

  test("6. item kedaluwarsa tidak muncul di hasil", async ({ page }) => {
    await login(page);
    await page.goto("/knowledge");

    const kemarin = new Date(Date.now() - 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    await page.getByLabel("Judul").fill("Promo Kedaluwarsa Contoh");
    await page
      .getByLabel("Konten teks")
      .fill("Promo spesial: gratis biaya kolam renang seumur hidup untuk pembeli.");
    await page.getByLabel("Berlaku s.d. (opsional)").fill(kemarin);
    await page.getByRole("button", { name: "Simpan & proses" }).click();

    const row = page.locator("section[aria-label='Daftar sumber'] > div", {
      hasText: "Promo Kedaluwarsa Contoh",
    });
    await expect(row.getByText("Siap")).toBeVisible({ timeout: 60000 });
    // Peringatan kedaluwarsa tampil di daftar.
    await expect(row.getByTestId("valid-expired")).toBeVisible();

    // Cari lagi: item kedaluwarsa TIDAK boleh muncul.
    await page.getByLabel("Query pencarian").fill("kolam renang");
    await page.getByRole("button", { name: "Cari" }).click();
    const panel = page.locator("section[aria-label='Tes pencarian']");
    await expect(
      panel.getByText("Fact Sheet Perumahan Contoh").first(),
    ).toBeVisible({ timeout: 30000 });
    await expect(panel.getByText("Promo Kedaluwarsa Contoh")).not.toBeVisible();
  });

  test("7. upload PDF via UI -> diproses (unpdf) -> Siap", async ({ page }) => {
    await login(page);
    await page.goto("/knowledge");

    const pdfPath = "/tmp/knowledge-e2e-brosur.pdf";
    writeFileSync(
      pdfPath,
      buildMinimalPdf("Brosur PDF Perumahan Contoh harga Rp900 juta"),
    );

    await page.getByRole("button", { name: "PDF" }).click();
    await page.getByLabel("Judul").fill("Brosur PDF Contoh");
    await page.locator("#kb-file").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "Simpan & proses" }).click();

    const row = page.locator("section[aria-label='Daftar sumber'] > div", {
      hasText: "Brosur PDF Contoh",
    });
    await expect(row.getByText("Siap")).toBeVisible({ timeout: 60000 });

    // Konten PDF bisa dicari.
    await page.getByLabel("Query pencarian").fill("brosur pdf");
    await page.getByRole("button", { name: "Cari" }).click();
    const panel = page.locator("section[aria-label='Tes pencarian']");
    await expect(panel.getByText("Brosur PDF Contoh").first()).toBeVisible({
      timeout: 30000,
    });
  });

  test("8. hapus item -> hilang dari daftar (chunk ikut terhapus)", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/knowledge");

    const list = page.locator("section[aria-label='Daftar sumber']");
    const row = list.locator("div", { hasText: "Fact Sheet Perumahan Contoh" }).first();

    page.on("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: "Hapus" }).click();

    await expect(list.getByText("Fact Sheet Perumahan Contoh")).not.toBeVisible({
      timeout: 15000,
    });
  });

  test("9. zero console error", async () => {
    expect(
      consoleErrors,
      `console.error: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
    ).toHaveLength(0);
  });
});
