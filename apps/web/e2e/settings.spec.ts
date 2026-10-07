import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 3 — settings terenkripsi + konfigurasi provider AI (BYOK).
 * UI sinkron dengan backend asli: Next.js + Prisma -> PGlite + Redis in-memory.
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-3.md).
 * Jalankan sendiri:  npx playwright test settings.spec.ts
 *
 * Server HTTP mock meniru provider OpenAI-compatible di 127.0.0.1:
 *   GET  /v1/models            -> daftar model
 *   POST /v1/chat/completions  -> balasan "pong"
 *   POST /v1/embeddings        -> vektor dummy
 */

const ADMIN_EMAIL = "e2e-settings@reza-ai.test";
const ADMIN_PASSWORD = "kata-sandi-e2e-345";
const E2E_API_KEY = "sk-e2e-secret-key-12345";

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function watchConsole(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
}

function totpNow(secret: string): string {
  return generateSync({ secret });
}

let mockServer: Server;
let mockPort = 0;

function startMockProvider(): Promise<number> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && req.url === "/v1/models") {
        json(200, { data: [{ id: "mock-chat-model" }, { id: "mock-embed-model" }] });
      } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
        // Mock menuntut Authorization yang benar — membuktikan UI/server
        // benar-benar mengirim key (termasuk via fallback key tersimpan).
        if (req.headers.authorization !== `Bearer ${E2E_API_KEY}`) {
          json(401, { error: { message: "Incorrect API key provided" } });
        } else {
          json(200, {
            id: "chatcmpl-e2e",
            choices: [{ message: { role: "assistant", content: "pong" } }],
          });
        }
      } else if (req.method === "POST" && req.url === "/v1/embeddings") {
        json(200, { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] });
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

test.describe.serial("Task 3 — settings provider AI + umum", () => {
  let totpSecret = "";

  test.beforeAll(async () => {
    await startMockProvider();
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  test("1. /setup: buat admin untuk file ini", async ({ page }) => {
    watchConsole(page);
    await page.goto("/setup");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Lanjut" }).click();

    await expect(page.getByAltText("Kode QR TOTP")).toBeVisible({ timeout: 15000 });
    totpSecret = await page.locator("#secret").inputValue();
    expect(totpSecret.length).toBeGreaterThanOrEqual(16);

    await page.getByLabel("Kode 6 digit dari aplikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Aktifkan dan selesai" }).click();
    await expect(page.getByText("Penyiapan selesai")).toBeVisible({ timeout: 15000 });
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

  test("2. deteksi model -> pilih model -> tes koneksi -> simpan -> reload persisten", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);

    // Link dari dashboard.
    await page.getByRole("link", { name: "Pengaturan" }).first().click();
    await expect(page).toHaveURL(/\/settings/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Pengaturan" })).toBeVisible();
    await expect(page.getByText("Provider AI")).toBeVisible();

    const chatCard = page.getByLabel("Slot Chat", { exact: true });
    const baseUrl = `http://127.0.0.1:${mockPort}/v1`;

    await chatCard.getByLabel("Nama").fill("MockAI");
    await chatCard.getByLabel("Base URL").fill(baseUrl);
    await chatCard.getByLabel("API key").fill(E2E_API_KEY);

    // Deteksi model mengisi dropdown.
    await chatCard.getByRole("button", { name: "Deteksi model" }).click();
    await expect(chatCard.getByText(/Ketemu 2 model/)).toBeVisible({ timeout: 15000 });
    await chatCard.getByLabel("Model").selectOption("mock-chat-model");

    // Tes koneksi sungguhan ke mock server.
    await chatCard.getByRole("button", { name: "Tes koneksi" }).click();
    await expect(chatCard.getByText(/Koneksi berhasil/)).toBeVisible({ timeout: 15000 });

    // Inherit untuk slot Embedding -> field-nya disabled.
    const embCard = page.getByLabel("Slot Embedding", { exact: true });
    await embCard.getByText("Sama dengan Chat").check();
    await expect(embCard.getByLabel("Base URL")).toBeDisabled();

    // Bagian umum: ubah nama persona + gaya bahasa.
    await page.getByLabel("Nama persona").fill("RezaE2E");
    await page.getByLabel("Gaya bahasa").selectOption("santai");

    // Simpan.
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText("Pengaturan tersimpan.")).toBeVisible({ timeout: 15000 });

    // Reload: nilai tampil persis, key ter-mask.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Pengaturan" })).toBeVisible({
      timeout: 15000,
    });
    const chatCard2 = page.getByLabel("Slot Chat", { exact: true });
    await expect(chatCard2.getByLabel("Base URL")).toHaveValue(baseUrl);
    await expect(chatCard2.getByLabel("Nama")).toHaveValue("MockAI");
    await expect(chatCard2.getByLabel("Model")).toHaveValue("mock-chat-model");
    // Key tidak tampil utuh — hanya masked + 4 digit terakhir.
    await expect(chatCard2.getByText("••••2345")).toBeVisible();
    await expect(chatCard2.getByLabel("API key")).toHaveValue("");
    // Umum persisten.
    await expect(page.getByLabel("Nama persona")).toHaveValue("RezaE2E");
    await expect(page.getByLabel("Gaya bahasa")).toHaveValue("santai");
    // Inherit persisten.
    const embCard2 = page.getByLabel("Slot Embedding", { exact: true });
    await expect(embCard2.getByText("Sama dengan Chat")).toBeChecked();
    await expect(embCard2.getByLabel("Base URL")).toBeDisabled();

    // API: GET /api/settings tidak membocorkan key utuh.
    // Lewat fetch di browser (bukan page.request): cookie sesi memakai
    // flag Secure (production), yang tidak dikirim fetch Node via
    // page.request ke http://127.0.0.1 — browser mengirimnya karena
    // localhost dianggap trustworthy.
    const apiRes = await page.evaluate(async () => {
      const r = await fetch("/api/settings");
      return { status: r.status, text: await r.text() };
    });
    expect(apiRes.status).toBe(200);
    const raw = apiRes.text;
    expect(raw).not.toContain(E2E_API_KEY);
    const data = JSON.parse(raw);
    const chat = data.providers.find((p: { slot: string }) => p.slot === "chat");
    expect(chat.apiKeyMasked).toBe("••••2345");
    expect(chat.keySet).toBe(true);
    expect(chat.baseUrl).toBe(baseUrl);
    expect(chat.model).toBe("mock-chat-model");
    expect("apiKey" in chat).toBe(false);
    expect("encryptedValue" in chat).toBe(false);
    const emb = data.providers.find((p: { slot: string }) => p.slot === "embedding");
    expect(emb.inherit).toBe(true);
    expect(data.general.personaName).toBe("RezaE2E");
    expect(data.general.personaTone).toBe("santai");

    // Simpan ulang dengan field API key dikosongkan -> key lama dipertahankan.
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText("Pengaturan tersimpan.")).toBeVisible({ timeout: 15000 });
    const apiRes2 = await page.evaluate(async () => {
      const r = await fetch("/api/settings");
      return { status: r.status, text: await r.text() };
    });
    expect(apiRes2.status).toBe(200);
    const chat2 = JSON.parse(apiRes2.text).providers.find(
      (p: { slot: string }) => p.slot === "chat",
    );
    expect(chat2.keySet).toBe(true);
    expect(chat2.apiKeyMasked).toBe("••••2345");

    // Tes koneksi dengan field key kosong -> pakai key tersimpan (fallback).
    const chatCard3 = page.getByLabel("Slot Chat", { exact: true });
    await expect(chatCard3.getByLabel("API key")).toHaveValue("");
    await chatCard3.getByRole("button", { name: "Tes koneksi" }).click();
    await expect(chatCard3.getByText(/Koneksi berhasil/)).toBeVisible({ timeout: 15000 });
  });

  test("3. API terproteksi tanpa sesi -> 401", async ({ request }) => {
    // Tanpa login: proxy mengembalikan 401 JSON untuk API.
    const get = await request.get("/api/settings");
    expect(get.status()).toBe(401);
    const post = await request.post("/api/providers/detect", {
      data: { slot: "chat", baseUrl: "http://x" },
    });
    expect(post.status()).toBe(401);
  });

  test("4. zero console error selama semua skenario", async () => {
    const realErrors = consoleErrors.filter(
      (m) => !/Failed to load resource.*status of 401/.test(m),
    );
    expect(pageErrors, `pageerror: ${pageErrors.join("\n")}`).toEqual([]);
    expect(realErrors, `console.error: ${realErrors.join("\n")}`).toEqual([]);
  });
});
