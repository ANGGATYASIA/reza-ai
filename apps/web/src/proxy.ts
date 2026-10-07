import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Nama cookie sesi — diduplikasi dari src/lib/auth.ts (SESSION_COOKIE)
// agar bundle edge ini tidak menarik dependensi Node (ioredis, argon2,
// PGlite, dsb.). Kalau nama cookie berubah, ubah di kedua tempat.
const SESSION_COOKIE = "reza_session";

// ============================================================
// Next 16 memakai konvensi `proxy.ts` (pengganti `middleware.ts`).
// File ini berjalan di edge runtime — hanya cek KEBERADAAN cookie
// sesi, tanpa akses Redis/DB. Validasi otoritatif tetap di
// requireAdmin() (setiap Route Handler) dan requireAdminPage()
// (Server Component): token dicek ke Redis di sana.
// Fungsi proxy di sini: UX redirect + garis pertahanan pertama.
// ============================================================

const PUBLIC_PAGE_PREFIXES = ["/login", "/setup", "/setup-2fa"];
const PUBLIC_API_PREFIXES = ["/api/health", "/api/auth", "/api/setup", "/api/setup-2fa"];

/** Diekspor untuk unit test (regression: /api/setup-2fa harus publik). */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/") return false;
  return (
    PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    PUBLIC_API_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
  );
}

function isPublic(pathname: string): boolean {
  return isPublicPath(pathname);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  // Halaman login/setup: yang sudah punya cookie sesi diarahkan ke dashboard.
  if ((pathname === "/login" || pathname === "/setup") && hasSessionCookie) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  // Jalur API terproteksi tanpa cookie -> 401 JSON (bukan redirect HTML).
  if (pathname.startsWith("/api/")) {
    if (!hasSessionCookie) {
      return NextResponse.json(
        { error: "Sesi berakhir atau tidak valid. Masuk kembali." },
        { status: 401 },
      );
    }
    return NextResponse.next();
  }

  // Halaman terproteksi tanpa cookie -> redirect ke /login.
  if (!hasSessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
