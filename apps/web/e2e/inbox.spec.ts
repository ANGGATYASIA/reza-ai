import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 5 — inbox realtime + kirim manual, dua arah, backend ASLI.
 *
 * Arsitektur yang diuji:
 *   test -> POST /api/test/inbox/simulate (E2E_TEST_API=1)
 *        -> FakeGateway harness (in-process di server Next.js)
 *        -> onMessage -> enqueueIngest (kode produksi @reza-ai/core)
 *        -> poller 250ms -> processInboundMessage REAL -> PGlite
 *        -> publish reza:inbox -> GET /api/inbox/stream (SSE real)
 *        -> EventSource di browser -> UI /inbox terupdate TANPA reload
 *
 *   test -> isi kotak balasan di UI -> POST /api/inbox/send
 *        -> enqueueSend (REAL) -> poller -> processSendJob REAL
 *        -> limiter -> FakeGateway.send -> Message {source: dashboard}
 *        Tercatat di GET /api/test/inbox/sent.
 *
 * JUJUR: yang disimulasikan HANYA pesan masuknya (seolah pelanggan
 * mengirim via WhatsApp) dan gateway-nya (FakeGateway, bukan Baileys —
 * worker asli tidak bisa jalan sebagai proses terpisah di sandbox
 * karena REDIS_URL=memory:// tidak lintas-proses dan PGlite tidak boleh
 * dibuka dua proses; lihat docs/demo-task-5.md). Seluruh jalur
 * ingest -> DB -> SSE -> UI dan UI -> antrean -> gateway adalah kode
 * produksi yang sama dipakai apps/worker.
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-5.md),
 * termasuk E2E_TEST_API=1.
 * Jalankan sendiri:  npx playwright test inbox.spec.ts
 */

const ADMIN_EMAIL = "e2e-inbox@reza-ai.test";
const ADMIN_PASSWORD = "kata-sandi-e2e-456";

const PN_LEAD = "628990001122";
const PN_INTERNAL = "628990003344";

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

/** Panggil API test-only lewat browser (cookie sesi ikut terkirim). */
async function testApi(
  page: Page,
  path: string,
  body?: unknown,
  method?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, body, method }: { path: string; body?: unknown; method?: string }) => {
      const res = await fetch(path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { status: res.status, data };
    },
    { path, body, method },
  );
}

async function simulate(page: Page, msg: Record<string, unknown>) {
  const { status, data } = await testApi(page, "/api/test/inbox/simulate", {
    timestamp: Date.now(),
    ...msg,
  });
  expect(status, `simulate gagal: ${JSON.stringify(data)}`).toBe(200);
}

async function findChatId(page: Page, pn: string): Promise<string> {
  const { status, data } = await testApi(page, "/api/inbox/chats?includeIgnored=1");
  expect(status).toBe(200);
  const chats = data.chats as Array<{ id: string; contact: { pn: string } }>;
  const chat = chats.find((c) => c.contact.pn === pn);
  expect(chat, `chat untuk ${pn} tidak ditemukan`).toBeTruthy();
  return chat!.id;
}

test.describe.serial("Task 5 — /inbox: realtime dua arah", () => {
  let totpSecret = "";

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

  test("2. dashboard -> link Kotak Masuk -> /inbox kosong", async ({ page }) => {
    watchConsole(page);
    await login(page);
    await page.getByRole("link", { name: "Kotak Masuk" }).click();
    await expect(page).toHaveURL(/\/inbox/, { timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Kotak Masuk" })).toBeVisible();
    await expect(page.getByText("Belum ada percakapan")).toBeVisible({
      timeout: 15000,
    });
  });

  test("3. nyalakan harness inbox (FakeGateway + consumer real)", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    const { status, data } = await testApi(page, "/api/test/inbox/harness", {});
    expect(status, `harness gagal: ${JSON.stringify(data)}`).toBe(200);
    expect(data.running).toBe(true);
    expect(data.connected).toBe(true);
  });

  test("4. pesan masuk -> tampil di /inbox TANPA reload (SSE)", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/inbox");
    await expect(page.getByText("Belum ada percakapan")).toBeVisible({
      timeout: 15000,
    });

    // Pelanggan mengirim pesan (disimulasikan; jalur setelahnya real).
    await simulate(page, {
      id: "e2e-t5-m1",
      from: PN_LEAD,
      body: "Halo, saya mau tanya harga",
    });

    // Chat muncul sendiri — tanpa reload.
    const chatItem = page
      .getByTestId("chat-list")
      .getByText("+62 899-0001-122");
    await expect(chatItem).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("unread-badge")).toHaveText("1", {
      timeout: 15000,
    });

    // Buka thread: pesan tampil + badge mode Full + tag Lead.
    await chatItem.click();
    await expect(
      page.getByTestId("thread").getByText("Halo, saya mau tanya harga"),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("mode-badge")).toHaveText("Full", {
      timeout: 15000,
    });
    await expect(
      page.getByTestId("thread-header").getByText("Lead"),
    ).toBeVisible();
  });

  test("5. kirim balasan dari UI -> sampai ke gateway + tersimpan", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/inbox");
    await page
      .getByTestId("chat-list")
      .getByText("+62 899-0001-122")
      .click();
    await expect(
      page.getByTestId("thread").getByText("Halo, saya mau tanya harga"),
    ).toBeVisible({ timeout: 15000 });

    const balasan = "Halo kak, terima kasih sudah menghubungi Grand Duta City.";
    await page.getByLabel("Tulis balasan").fill(balasan);
    await page.getByRole("button", { name: "Kirim" }).click();

    // Optimistic UI: langsung tampil sebagai pesan sendiri.
    await expect(
      page.getByTestId("thread").getByText(balasan),
    ).toBeVisible({ timeout: 15000 });

    // BUKTI sampai ke gateway: FakeGateway mencatat pengiriman.
    await expect(async () => {
      const { status, data } = await testApi(page, "/api/test/inbox/sent");
      expect(status).toBe(200);
      const texts = data.texts as Array<{ to: string; body: string }>;
      const found = texts.find(
        (t) => t.to === PN_LEAD && t.body === balasan,
      );
      expect(found, `tidak terkirim ke gateway: ${JSON.stringify(texts)}`).toBeTruthy();
    }).toPass({ timeout: 15000 });

    // BUKTI tersimpan di DB sebagai fromMe + source dashboard.
    const chatId = await findChatId(page, PN_LEAD);
    const { data } = await testApi(page, `/api/inbox/chats/${chatId}`);
    const messages = data.messages as Array<{
      body: string;
      fromMe: boolean;
      source: string;
    }>;
    const saved = messages.find((m) => m.body === balasan);
    expect(saved).toBeTruthy();
    expect(saved!.fromMe).toBe(true);
    expect(saved!.source).toBe("dashboard");
  });

  test("6. impor nomor Internal -> badge Internal + disembunyikan", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/inbox");
    await expect(page.getByTestId("chat-list")).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "Nomor internal" }).click();
    await page
      .getByLabel("Daftar nomor internal")
      .fill("628990003344\nnomor-ngawur");
    await page.getByRole("button", { name: "Tandai sebagai Internal" }).click();
    await expect(
      page.getByText("1 nomor ditandai Internal."),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText("Tidak dikenali: nomor-ngawur."),
    ).toBeVisible({ timeout: 15000 });

    // Pesan dari nomor internal: otomatis ignored -> tidak tampil di Semua.
    await simulate(page, {
      id: "e2e-t5-m2",
      from: PN_INTERNAL,
      body: "pesan orang dalam",
    });
    await page.waitForTimeout(2500);
    await expect(
      page.getByTestId("chat-list").getByText("+62 899-0003-344"),
    ).toHaveCount(0);

    // Tampil di tab Disembunyikan dengan badge Internal.
    await page.getByRole("tab", { name: "Disembunyikan" }).click();
    const hiddenItem = page
      .getByTestId("chat-list")
      .getByText("+62 899-0003-344");
    await expect(hiddenItem).toBeVisible({ timeout: 15000 });
    await hiddenItem.click();
    await expect(
      page.getByTestId("thread-header").getByText("Internal"),
    ).toBeVisible({ timeout: 15000 });
  });

  test("7. pesan fromMe dari HP -> tersimpan source=phone, label 'dari HP'", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/inbox");
    await page
      .getByTestId("chat-list")
      .getByText("+62 899-0001-122")
      .click();
    await expect(
      page.getByTestId("thread").getByText("Halo, saya mau tanya harga"),
    ).toBeVisible({ timeout: 15000 });

    // Balasan diketik di HP (bukan dari dashboard).
    await simulate(page, {
      id: "e2e-t5-hp1",
      from: PN_LEAD,
      fromMe: true,
      source: "phone",
      body: "Saya follow up dari HP ya kak",
    });

    const thread = page.getByTestId("thread");
    await expect(
      thread.getByText("Saya follow up dari HP ya kak"),
    ).toBeVisible({ timeout: 15000 });
    await expect(thread.getByTestId("msg-from-phone")).toBeVisible({
      timeout: 15000,
    });

    // BUKTI di DB: source=phone, fromMe=true (hook untuk Task 8).
    const chatId = await findChatId(page, PN_LEAD);
    const { data } = await testApi(page, `/api/inbox/chats/${chatId}`);
    const messages = data.messages as Array<{
      body: string;
      fromMe: boolean;
      source: string;
    }>;
    const saved = messages.find(
      (m) => m.body === "Saya follow up dari HP ya kak",
    );
    expect(saved).toBeTruthy();
    expect(saved!.fromMe).toBe(true);
    expect(saved!.source).toBe("phone");
  });

  test("8. API inbox tanpa sesi -> 401", async ({
    request,
  }) => {
    expect((await request.get("/api/inbox/chats")).status()).toBe(401);
    expect((await request.get("/api/inbox/stream")).status()).toBe(401);
    expect(
      (await request.post("/api/inbox/send", { data: {} })).status(),
    ).toBe(401);
    expect(
      (await request.post("/api/inbox/contacts/import", { data: {} })).status(),
    ).toBe(401);
  });

  test("9. zero console error selama semua skenario", async () => {
    expect(pageErrors, `pageerror: ${pageErrors.join("\n")}`).toEqual([]);
    expect(consoleErrors, `console.error: ${consoleErrors.join("\n")}`).toEqual(
      [],
    );
  });
});
