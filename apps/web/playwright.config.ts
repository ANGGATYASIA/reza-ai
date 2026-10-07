import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    // Pakai chromium full (bukan headless-shell): yang terinstal manual
    // di ~/.cache/ms-playwright/chromium-1243.
    launchOptions: { channel: "chromium" },
  },
  // Server dijalankan manual (lihat docs/demo-task-2.md) agar env
  // PGlite + Redis in-memory bisa diatur eksplisit sebelum run.
});
