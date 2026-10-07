import Redis from "ioredis-mock";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  createSession,
  requireAdmin,
  type AdminReader,
} from "../src/lib/auth.js";

let redis: InstanceType<typeof Redis>;

const fakeDb: AdminReader = {
  admin: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      if (where.id === "admin-1") return { id: "admin-1", email: "admin@example.id" };
      return null;
    },
  },
};

function requestWithCookie(cookieValue?: string): NextRequest {
  const req = new NextRequest(new URL("http://localhost/api/admin/me"));
  if (cookieValue !== undefined) {
    req.cookies.set(SESSION_COOKIE, cookieValue);
  }
  return req;
}

beforeEach(() => {
  redis = new Redis();
});

afterEach(() => {
  redis.disconnect();
});

// ---------------- (d) Proteksi route ----------------

describe("requireAdmin — proteksi route", () => {
  it("tanpa cookie sesi -> 401", async () => {
    const result = await requireAdmin(requestWithCookie(), redis, fakeDb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error).toMatch(/Masuk kembali/);
    }
  });

  it("token sesi tak dikenal -> 401", async () => {
    const result = await requireAdmin(requestWithCookie("token-palsu"), redis, fakeDb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("sesi valid + admin ada -> lolos dengan identitas", async () => {
    const token = await createSession(redis, "admin-1");
    const result = await requireAdmin(requestWithCookie(token), redis, fakeDb);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.admin).toEqual({ id: "admin-1", email: "admin@example.id" });
    }
  });

  it("sesi valid tetapi admin sudah dihapus -> 401 + sesi dihancurkan", async () => {
    const token = await createSession(redis, "admin-tak-ada");
    const result = await requireAdmin(requestWithCookie(token), redis, fakeDb);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    // Sesi yatim dibersihkan agar tidak bisa dipakai lagi.
    expect(await redis.get(`reza:session:${token}`)).toBeNull();
  });
});
