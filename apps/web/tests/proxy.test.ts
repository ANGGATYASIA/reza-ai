import { describe, expect, it } from "vitest";
import { isPublicPath } from "../src/proxy.js";

// ---------------- (d) Proteksi route — level proxy ----------------
// Proxy hanya cek KEBERADAAN cookie sesi; validasi otoritatif ada di
// requireAdmin() (lihat protection.test.ts). Di sini: pemetaan publik
// vs terproteksi harus tepat.

describe("proxy isPublicPath", () => {
  it("jalur publik: login, setup, setup-2fa, health, auth, setup API", () => {
    for (const p of [
      "/login",
      "/setup",
      "/setup-2fa",
      "/api/health",
      "/api/auth/login",
      "/api/auth/totp",
      "/api/auth/logout",
      "/api/setup/status",
      "/api/setup/admin",
      "/api/setup/totp-enroll",
      "/api/setup-2fa/enroll",
      "/api/setup-2fa/verify",
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it("jalur terproteksi: dashboard, root, API admin", () => {
    for (const p of ["/", "/dashboard", "/api/admin/me", "/api/settings"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it("prefix mirip tidak lolos (/api/setup-2fa ≠ /api/setupx)", () => {
    expect(isPublicPath("/api/setupx")).toBe(false);
    expect(isPublicPath("/setuplagi")).toBe(false);
  });
});
