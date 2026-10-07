# Demo Task 2 — Autentikasi Admin + 2FA

Tanggal: 2026-10-07. Semua bukti di bawah direproduksi di sandbox dengan backend ASLI
(Next.js + Prisma -> PGlite + Redis in-memory), bukan mock.

## Ringkasan hasil

| Lapisan | Hasil |
|---|---|
| Unit test `packages/core` | 28/28 hijau (argon2, TOTP crypto round-trip, dsb.) |
| Unit test `apps/web` | 25/25 hijau (TOTP, rate limit, sesi, proteksi route, proxy) |
| E2E Playwright (chromium asli) | 8/8 hijau, zero console error/pageerror |
| Verifikasi curl | proteksi route, rate limit 429, alur reset-2FA |

## Cara reproduksi E2E

```bash
# 1. Reset database E2E (PGlite, persisten di apps/web/data/e2e)
cd apps/web && pnpm e2e:reset-db

# 2. Jalankan server production dengan backend E2E
export DATABASE_URL="pglite://$HOME/workspace/reza-ai/apps/web/data/e2e"
export REDIS_URL="memory://"
export MASTER_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export TOTP_ISSUER="Reza AI"
npx next start -p 3100

# 3. Jalankan Playwright (butuh chromium di ~/.cache/ms-playwright)
npx playwright test
```

Chromium diinstal manual karena downloader Playwright timeout lewat proxy sandbox:
unduh via `curl` dari `cdn.playwright.dev`, ekstrak ke
`~/.cache/ms-playwright/chromium-1243/chrome-linux64/`, dan pakai
`launchOptions: { channel: "chromium" }` di `playwright.config.ts`.

## Skenario E2E (e2e/auth.spec.ts)

1. **Setup wizard** — buka `/setup` -> isi email + kata sandi -> kode QR TOTP tampil
   (render dari data URL server) + secret manual -> generate kode via otplib di test
   dari secret yang tampil -> verifikasi -> "Penyiapan selesai" -> ke `/login`.
2. **Setup ditolak bila admin ada** — buka `/setup` lagi -> redirect `/login`.
3. **Login 2 langkah** — email + kata sandi benar -> fase TOTP -> kode benar ->
   `/dashboard` menampilkan "Masuk sebagai e2e-admin@reza-ai.test", status
   Basis data = Normal, Redis = Normal (REAL dari `/api/health` via PGlite).
4. **Logout** — klik Keluar -> `/login`; buka `/dashboard` -> memantul ke `/login`.
5. **Kata sandi salah** — pesan "Email atau kata sandi salah." tampil di UI.
6. **Kode TOTP salah** — pesan "Kode verifikasi salah..." tampil di UI.
7. **API tanpa sesi** — `GET /api/admin/me` -> 401.
8. **Zero console error** — tidak ada `pageerror`; `console.error` hanya
   mengabaikan "Failed to load resource ... 401" yang disengaja dari skenario 5-6
   (fetch yang memang diuji gagal; UI menanganinya).

## Verifikasi curl (tambahan, di luar Playwright)

- `GET /dashboard` tanpa cookie -> `307 -> /login?next=%2Fdashboard`
- `GET /api/admin/me` tanpa cookie -> `401 {"error":"Sesi berakhir atau tidak valid..."}`
- `GET /api/health` publik, tanpa cookie -> 503 dengan `db:"ok", redis:"ok"`
  (503 karena worker belum jalan — jujur, bukan bug)
- Rate limit: 4x `401` lalu `429 {"error":"Terlalu banyak percobaan, coba lagi dalam 15 menit."}`
  (counter sudah 1 dari skenario E2E; sukses me-reset — diverifikasi di unit test)
- Alur darurat reset 2FA: `reset-admin.mjs --reset-totp` -> login memberi
  `{"next":"enroll-2fa"}` -> `GET /api/setup-2fa/enroll` -> QR -> verifikasi kode ->
  sesi penuh -> `/api/admin/me` 200.

## Batasan yang diakui jujur

- E2E memakai **Redis in-memory** (`REDIS_URL=memory://`, ioredis-mock), bukan
  server Redis asli — tidak ada redis-server di sandbox (apt rusak, paket npm
  `redis-server` butuh binary sistem). Protokol Redis-nya asli; di VPS pakai
  Redis asli via `REDIS_URL=redis://...`. Sesi & rate limit tidak terbagi antar
  proses dalam mode ini (tidak relevan untuk E2E satu proses).
- E2E memakai **PGlite** (Postgres WASM) via `DATABASE_URL=pglite://...`, bukan
  postgres native. Migrasi SQL asli (termasuk `CREATE EXTENSION vector`, HNSW,
  tsvector) diterapkan via `packages/core/scripts/pglite-migrate.mjs`.
- `next build` memakai flag `--webpack` (lihat README bagian "Testing & E2E di
  sandbox" untuk alasannya).
