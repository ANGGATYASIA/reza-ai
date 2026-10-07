import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 7 — playground AI: UI sinkron dengan backend ASLI.
 *
 * Arsitektur yang diuji:
 *   UI /playground -> POST /api/playground/chat (REAL)
 *        -> generateReply ASLI (@reza-ai/core):
 *           hybridSearch REAL (vector HNSW + FTS GIN + RRF -> PGlite)
 *           -> gerbang sufficiency (intent sensitif / 0 chunk)
 *           -> POST {baseUrl}/chat/completions REAL (fetch produksi)
 *           -> validasi Zod -> objek balasan
 *        -> UI: balasan + badge keyakinan + daftar sumber / banner handoff
 *
 * JUJUR: yang disimulasikan HANYA provider-nya —
 *   (1) embedding: server HTTP mock lokal (vektor hash deterministik
 *       per kata, pola Task 6; menuntut Bearer e2e-test-key),
 *   (2) chat: server HTTP mock lokal (OpenAI-compatible
 *       POST /chat/completions, JSON canned; menuntut Bearer
 *       e2e-chat-key — membuktikan API key terenkripsi mengalir),
 * dan data knowledge-nya (seed "DATA UJI (fiktif)" via
 * /api/test/playground/seed — harga Verona Rp950 juta BUKAN harga
 * sungguhan, didokumentasikan di docs/demo-task-7.md).
 * Seluruh jalur generateReply (retrieval, gerbang intent, prompt,
 * parsing) adalah kode produksi.
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-6.md),
 * termasuk E2E_TEST_API=1.
 * Jalankan sendiri:  npx playwright test playground.spec.ts
 */

const ADMIN_EMAIL = "e2e-playground@reza-ai.test";
const ADMIN_PASSWORD = "Katasandi!E2EPlayground7";
const E2E_EMBED_KEY = "e2e-test-key";
const E2E_CHAT_KEY = "e2e-chat-key";
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

let embedServer: Server;
let chatServer: Server;
let embedPort = 0;
let chatPort = 0;

function startMockEmbedding(): Promise<number> {
  return new Promise((resolve) => {
    embedServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/embeddings") {
        if (req.headers.authorization !== `Bearer ${E2E_EMBED_KEY}`) {
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
    embedServer.listen(0, "127.0.0.1", () => {
      embedPort = (embedServer.address() as { port: number }).port;
      resolve(embedPort);
    });
  });
}

/**
 * Mock chat OpenAI-compatible. Menjawab berdasar isi pesan user:
 * - mengandung "diskon"/"nego" -> JSON handoff (jalur defensif; di
 *   praktiknya gerbang intent di generateReply sudah handoff duluan
 *   tanpa memanggil LLM sama sekali)
 * - selain itu -> JSON canned confidence 0.9, sourcesUsed [1]
 */
function startMockChat(): Promise<number> {
  return new Promise((resolve) => {
    chatServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/chat/completions") {
        if (req.headers.authorization !== `Bearer ${E2E_CHAT_KEY}`) {
          json(401, { error: { message: "Incorrect API key provided" } });
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const users = (body.messages ?? []).filter((m) => m.role === "user");
          const lastUser = users[users.length - 1]?.content ?? "";
          const handoff = /diskon|nego/i.test(lastUser);
          const reply = handoff
            ? {
                reply: "",
                confidence: 0,
                handoff: true,
                reason: "Negosiasi harga/diskon — perlu persetujuan Reza langsung",
                sourcesUsed: [],
              }
            : {
                // Data uji — harga fiktif dari seed, BUKAN harga sungguhan.
                reply:
                  "Harga tipe Verona mulai Rp950 juta (data uji untuk playground). Mau aku infoin detail lainnya?",
                confidence: 0.9,
                handoff: false,
                reason: null,
                sourcesUsed: [1],
              };
          json(200, { choices: [{ message: { content: JSON.stringify(reply) } }] });
        });
      } else {
        json(404, { error: "not found" });
      }
    });
    chatServer.listen(0, "127.0.0.1", () => {
      chatPort = (chatServer.address() as { port: number }).port;
      resolve(chatPort);
    });
  });
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

test.describe.serial("Task 7 — /playground: UI sinkron backend", () => {
  let totpSecret = "";

  test.beforeAll(async () => {
    await startMockEmbedding();
    await startMockChat();
  });

  test.afterAll(async () => {
    embedServer.close();
    chatServer.close();
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

  async function sendAsLead(page: Page, text: string) {
    const before = await page.getByTestId("msg-reza").count();
    await page.getByLabel("Pesan sebagai lead").fill(text);
    await page.getByRole("button", { name: "Kirim" }).click();
    // Tunggu balasan Reza yang baru muncul (bukan loading).
    await expect(page.getByTestId("msg-reza")).toHaveCount(before + 1, {
      timeout: 30000,
    });
    return page.getByTestId("msg-reza").nth(before);
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

  test("2. arahkan slot embedding+chat ke mock, lalu seed knowledge", async ({
    page,
  }) => {
    await login(page);

    const e = await testApi(page, "/api/test/knowledge/mock-embedding", {
      baseUrl: `http://127.0.0.1:${embedPort}`,
      apiKey: E2E_EMBED_KEY,
      model: "mock-embed-1536",
    });
    expect(e.status, `mock-embedding gagal: ${JSON.stringify(e.data)}`).toBe(200);

    const c = await testApi(page, "/api/test/playground/mock-chat", {
      baseUrl: `http://127.0.0.1:${chatPort}`,
      apiKey: E2E_CHAT_KEY,
      model: "mock-chat",
    });
    expect(c.status, `mock-chat gagal: ${JSON.stringify(c.data)}`).toBe(200);

    const s = await testApi(page, "/api/test/playground/seed");
    expect(s.status, `seed gagal: ${JSON.stringify(s.data)}`).toBe(200);
    expect(s.data.chunks, `seed gagal: ${JSON.stringify(s.data)}`).toBe(1);
  });

  test("3. dashboard -> /playground", async ({ page }) => {
    await login(page);
    await page.getByRole("link", { name: "Playground AI" }).click();
    await expect(page).toHaveURL(/\/playground/);
    await expect(
      page.getByRole("heading", { name: "Playground AI" }),
    ).toBeVisible();
  });

  test("4. tanya harga -> balasan + badge keyakinan + sumber", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/playground");

    const reply = await sendAsLead(page, "Harga tipe Verona berapa?");
    // Balasan dari alur nyata: retrieval asli + LLM mock via fetch produksi.
    await expect(reply.getByText(/Rp950 juta/)).toBeVisible();
    // Badge keyakinan 90% (confidence 0.9 dari JSON canned).
    await expect(reply.getByTestId("confidence-badge")).toHaveText(
      /Keyakinan 90%/,
    );
    // Daftar sumber: judul item knowledge yang dikutip.
    const sources = reply.getByTestId("sources-list");
    await expect(sources).toBeVisible();
    await expect(sources.getByText(/Daftar Harga Tipe Verona/)).toBeVisible();
    // Bukan handoff: tidak ada banner.
    await expect(reply.getByTestId("handoff-banner")).not.toBeVisible();
  });

  test("5. tanya diskon -> banner handoff + reason (gerbang intent)", async ({
    page,
  }) => {
    await login(page);
    await page.goto("/playground");

    const reply = await sendAsLead(page, "Bisa diskon 10%?");
    // Gerbang intent sensitif di generateReply: handoff tanpa panggil LLM.
    const banner = reply.getByTestId("handoff-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(/Diteruskan ke Reza/);
    await expect(banner).toHaveText(/Negosiasi harga\/diskon/);
  });

  test("6. zero console error", async () => {
    expect(
      consoleErrors,
      `console.error: ${JSON.stringify(consoleErrors.slice(0, 5))}`,
    ).toHaveLength(0);
  });
});
