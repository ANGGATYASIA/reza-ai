import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 2 — autentikasi admin + 2FA, UI sinkron dengan backend asli:
 * Next.js + Prisma -> PGlite (Postgres WASM) + Redis in-memory.
 *
 * Prasyarat (lihat docs/demo-task-2.md):
 *   DATABASE_URL=pglite://./data/e2e  REDIS_URL=memory://  MASTER_KEY=...
 *   + migrasi via packages/core/scripts/pglite-migrate.mjs
 *   + server jalan di http://127.0.0.1:3100
 */

const ADMIN_EMAIL = "e2e-admin@reza-ai.test";
const ADMIN_PASSWORD = "kata-sandi-e2e-123";

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

test.describe("Task 2 — setup, login 2 langkah, dashboard, logout, proteksi", () => {
  let totpSecret = "";

  test("1. /setup: buat admin -> QR TOTP tampil -> verifikasi -> selesai", async ({ page }) => {
    watchConsole(page);
    await page.goto("/setup");

    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Lanjut" }).click();

    // Langkah 2: QR + secret manual tampil.
    await expect(page.getByAltText("Kode QR TOTP")).toBeVisible({ timeout: 15000 });
    totpSecret = await page.locator("#secret").inputValue();
    expect(totpSecret.length).toBeGreaterThanOrEqual(16);

    await page.getByLabel("Kode 6 digit dari aplikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Aktifkan dan selesai" }).click();

    await expect(page.getByText("Penyiapan selesai")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Masuk ke dashboard" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("2. /setup menolak bila admin sudah ada (redirect /login)", async ({ page }) => {
    watchConsole(page);
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });

  test("3. login 2 langkah sukses -> /dashboard tampilkan email", async ({ page }) => {
    watchConsole(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();

    await expect(page.getByText("Verifikasi dua langkah")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Kode verifikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
    await expect(page.getByText(`Masuk sebagai ${ADMIN_EMAIL}`)).toBeVisible();
    // Status sistem REAL dari backend.
    await expect(page.getByText("Basis data").locator("..").getByText("Normal")).toBeVisible();
    await expect(page.getByText("Redis").locator("..").getByText("Normal")).toBeVisible();
  });

  test("4. logout -> /dashboard redirect ke /login", async ({ page }) => {
    watchConsole(page);
    // Login dulu via UI.
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.getByLabel("Kode verifikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });

    await page.getByRole("button", { name: "Keluar" }).click();
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });

    // Sesi sudah mati: dashboard memantul kembali ke /login.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/, { timeout: 15000 });
  });

  test("5. kata sandi salah -> pesan galat tampil di UI", async ({ page }) => {
    watchConsole(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill("kata-sandi-salah-123");
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page.getByText("Email atau kata sandi salah.")).toBeVisible({
      timeout: 15000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("6. kode TOTP salah -> pesan galat tampil di UI", async ({ page }) => {
    watchConsole(page);
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page.getByText("Verifikasi dua langkah")).toBeVisible({ timeout: 15000 });
    await page.getByLabel("Kode verifikasi").fill("000000");
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();
    await expect(page.getByText("Kode verifikasi salah", { exact: false })).toBeVisible({
      timeout: 15000,
    });
  });

  test("7. API terproteksi tanpa sesi -> 401", async ({ request }) => {
    const res = await request.get("/api/admin/me");
    expect(res.status()).toBe(401);
  });

  test("8. zero console error selama semua skenario", async () => {
    // "Failed to load resource ... 401" adalah noise Chrome untuk fetch
    // yang SENGAJA diuji gagal (skenario 5 & 6: kredensial salah -> 401
    // yang ditangani UI). Selain itu, semua console.error/pageerror
    // dianggap cacat.
    const realErrors = consoleErrors.filter(
      (m) => !/Failed to load resource.*status of 401/.test(m),
    );
    expect(
      pageErrors,
      `pageerror: ${pageErrors.join("\n")}`,
    ).toEqual([]);
    expect(
      realErrors,
      `console.error: ${realErrors.join("\n")}`,
    ).toEqual([]);
  });
});
