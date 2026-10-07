import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 4 — halaman /whatsapp: QR + status sinkron dengan backend.
 *
 * Arsitektur yang diuji (REAL, bukan mock UI):
 *   test -> POST /api/test/whatsapp/publish (E2E_TEST_API=1)
 *        -> Redis pub/sub channel reza:wa:status (proses server, ioredis-mock)
 *        -> GET /api/whatsapp/stream (SSE, subscribe beneran)
 *        -> EventSource di browser -> render QR / status
 *
 * JUJUR: yang disimulasikan HANYA payload event-nya (seolah worker Baileys
 * mengirim QR/open). Seluruh jalur SSE -> UI adalah kode produksi.
 * Perintah Logout dibuktikan terkirim via antrean wa-command (list fallback
 * di E2E, dibaca lewat /api/test/whatsapp/commands).
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-4.md),
 * termasuk E2E_TEST_API=1.
 * Jalankan sendiri:  npx playwright test whatsapp.spec.ts
 */

const ADMIN_EMAIL = "e2e-wa@reza-ai.test";
const ADMIN_PASSWORD = "kata-sandi-e2e-789";

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
): Promise<{ status: number; data: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, body }: { path: string; body?: unknown }) => {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { status: res.status, data };
    },
    { path, body },
  );
}

async function publishStatus(
  page: Page,
  payload: Record<string, unknown>,
): Promise<void> {
  const { status, data } = await testApi(
    page,
    "/api/test/whatsapp/publish",
    payload,
  );
  expect(status, `publish gagal: ${JSON.stringify(data)}`).toBe(200);
}

test.describe.serial("Task 4 — /whatsapp: QR + status via SSE real", () => {
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

  test("2. login -> /dashboard -> link Koneksi WhatsApp -> /whatsapp", async ({
    page,
  }) => {
    watchConsole(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.getByLabel("Kode verifikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

    await page.getByRole("link", { name: "Koneksi WhatsApp" }).click();
    await expect(page).toHaveURL(/\/whatsapp/, { timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: "Koneksi WhatsApp" }),
    ).toBeVisible();
    // Belum ada status dari worker -> state "unknown".
    await expect(page.getByText("Belum ada kabar dari worker")).toBeVisible({
      timeout: 15000,
    });
  });

  test("3. event QR simulasi -> QR ter-render sebagai gambar", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/whatsapp");
    await expect(page.getByText("Belum ada kabar dari worker")).toBeVisible({
      timeout: 15000,
    });

    // Simulasi worker mengirim QR (payload disimulasikan, jalur SSE real).
    await publishStatus(page, {
      status: "qr",
      qr: "e2e-simulated-qr-payload-12345",
    });

    const qrImg = page.getByAltText("Kode QR WhatsApp");
    await expect(qrImg).toBeVisible({ timeout: 15000 });
    const src = await qrImg.getAttribute("src");
    expect(src).toMatch(/^data:image\/png;base64,/);
    await expect(page.getByTestId("wa-status")).toHaveText("Menunggu dipindai");
  });

  test("4. connecting -> open: UI tampil Terhubung + nama + nomor", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/whatsapp");
    await expect(page.getByAltText("Kode QR WhatsApp")).toBeVisible({
      timeout: 15000,
    });

    await publishStatus(page, { status: "connecting" });
    await expect(page.getByTestId("wa-status")).toHaveText("Menghubungkan…", {
      timeout: 15000,
    });

    await publishStatus(page, {
      status: "open",
      phone: "6282114812842",
      name: "Reza AI",
    });
    await expect(page.getByTestId("wa-status")).toHaveText("Terhubung", {
      timeout: 15000,
    });
    await expect(
      page.getByText("Terhubung: Reza AI (6282114812842)"),
    ).toBeVisible();
  });

  test("5. klik Logout (konfirmasi 2x) -> perintah terkirim ke wa-command", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/whatsapp");
    await expect(page.getByTestId("wa-status")).toHaveText("Terhubung", {
      timeout: 15000,
    });

    const logoutBtn = page.getByRole("button", { name: "Logout" });
    await logoutBtn.click();
    // Klik pertama: minta konfirmasi.
    await expect(
      page.getByText("Klik Logout sekali lagi untuk mengonfirmasi."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Klik lagi untuk konfirmasi" })
      .click();

    await expect(
      page.getByText("Perintah logout dikirim", { exact: false }),
    ).toBeVisible({ timeout: 15000 });

    // BUKTI perintah terkirim: baca antrean wa-command (list fallback E2E).
    const { status, data } = await testApi(
      page,
      "/api/test/whatsapp/commands",
    );
    expect(status).toBe(200);
    const commands = data.commands as Array<{ command: string }>;
    expect(commands.length).toBeGreaterThanOrEqual(1);
    expect(commands[commands.length - 1].command).toBe("logout");
  });

  test("6. QR baru setelah logout -> UI auto-refresh", async ({ page }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/whatsapp");

    await publishStatus(page, { status: "qr", qr: "qr-baru-setelah-logout" });
    await expect(page.getByAltText("Kode QR WhatsApp")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("wa-status")).toHaveText("Menunggu dipindai");
  });

  test("7. status restricted (463) -> banner Dibatasi", async ({ page }) => {
    watchConsole(page);
    await login(page);
    await page.goto("/whatsapp");

    await publishStatus(page, { status: "restricted", reason: "463" });
    await expect(page.getByTestId("wa-status")).toHaveText("Dibatasi (463)", {
      timeout: 15000,
    });
    await expect(
      page.getByText("WhatsApp membatasi akun ini", { exact: false }),
    ).toBeVisible();
  });

  test("8. API whatsapp tanpa sesi -> 401", async ({ request }) => {
    expect((await request.get("/api/whatsapp/stream")).status()).toBe(401);
    expect(
      (await request.post("/api/whatsapp/command", { data: {} })).status(),
    ).toBe(401);
  });

  test("9. zero console error selama semua skenario", async () => {
    expect(pageErrors, `pageerror: ${pageErrors.join("\n")}`).toEqual([]);
    expect(consoleErrors, `console.error: ${consoleErrors.join("\n")}`).toEqual(
      [],
    );
  });
});
