import { describe, expect, it, vi } from "vitest";
import {
  detectModels,
  probeErrorMessage,
  testProviderConnection,
} from "../src/lib/provider-probe.js";

/**
 * Unit test Task 3 — deteksi model & tes koneksi provider.
 * fetch di-mock total; tidak ada request jaringan sungguhan.
 */

function mockFetch(
  handler: (url: string, init?: RequestInit) => unknown,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("detectModels", () => {
  it("format OpenAI -> daftar model", async () => {
    const f = mockFetch(async (url) => {
      expect(url).toBe("https://provider.test/v1/models");
      return jsonResponse(200, { data: [{ id: "model-a" }, { id: "model-b" }] });
    });
    const res = await detectModels("https://provider.test/v1/", "sk-x", f);
    expect(res).toEqual({ models: ["model-a", "model-b"] });
  });

  it("base URL tanpa trailing slash tetap benar", async () => {
    const f = mockFetch(async (url) => {
      expect(url).toBe("https://provider.test/v1/models");
      return jsonResponse(200, { data: [{ id: "m" }] });
    });
    const res = await detectModels("https://provider.test/v1", undefined, f);
    expect(res.models).toEqual(["m"]);
  });

  it("kirim Authorization header bila apiKey diisi", async () => {
    const f = mockFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        "Bearer sk-rahasia",
      );
      return jsonResponse(200, { data: [{ id: "m" }] });
    });
    await detectModels("https://x.test", "sk-rahasia", f);
  });

  it("401 -> pesan Bahasa Indonesia yang jelas", async () => {
    const f = mockFetch(async () => jsonResponse(401, { error: "unauthorized" }));
    const res = await detectModels("https://x.test", "sk-salah", f);
    expect(res.error).toMatch(/API key ditolak/);
  });

  it("jaringan mati -> pesan koneksi, bukan stack trace", async () => {
    const f = mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await detectModels("https://x.test", undefined, f);
    expect(res.error).toMatch(/Tidak bisa terhubung/);
  });

  it("respons bukan JSON -> pesan jelas", async () => {
    const f = mockFetch(
      async () => new Response("<html>bukan json</html>", { status: 200 }),
    );
    const res = await detectModels("https://x.test", undefined, f);
    expect(res.error).toMatch(/bukan JSON|tidak mengembalikan JSON/);
  });

  it("data kosong -> pesan jelas", async () => {
    const f = mockFetch(async () => jsonResponse(200, { data: [] }));
    const res = await detectModels("https://x.test", undefined, f);
    expect(res.error).toMatch(/tidak ada daftar model/);
  });
});

describe("testProviderConnection", () => {
  it("slot chat: POST /chat/completions dengan ping", async () => {
    const f = mockFetch(async (url, init) => {
      expect(url).toBe("https://p.test/v1/chat/completions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("model-chat");
      expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
      return jsonResponse(200, {
        choices: [{ message: { content: "pong" } }],
      });
    });
    const res = await testProviderConnection("chat", "https://p.test/v1", "sk-x", "model-chat", f);
    expect(res.ok).toBe(true);
    expect(typeof res.latencyMs).toBe("number");
    expect(res.detail).toMatch(/ping/);
  });

  it("slot embedding: POST /embeddings", async () => {
    const f = mockFetch(async (url, init) => {
      expect(url).toBe("https://p.test/v1/embeddings");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: "model-emb", input: "tes" });
      return jsonResponse(200, { data: [{ embedding: [0.1] }] });
    });
    const res = await testProviderConnection(
      "embedding",
      "https://p.test/v1",
      "sk-x",
      "model-emb",
      f,
    );
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/embeddings/);
  });

  it("slot transcription: GET /models (tanpa POST audio)", async () => {
    const f = mockFetch(async (url, init) => {
      expect(url).toBe("https://p.test/v1/models");
      expect(init?.method).not.toBe("POST");
      return jsonResponse(200, { data: [{ id: "whisper-1" }] });
    });
    const res = await testProviderConnection(
      "transcription",
      "https://p.test/v1",
      "sk-x",
      "",
      f,
    );
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/berkas audio/);
  });

  it("404 -> pesan menyebut endpoint/base URL", async () => {
    const f = mockFetch(async () => jsonResponse(404, {}));
    const res = await testProviderConnection("chat", "https://p.test/v1", "sk-x", "m", f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/404/);
  });

  it("401 dengan pesan provider -> pesan digabung", async () => {
    const f = mockFetch(async () =>
      jsonResponse(401, { error: { message: "Incorrect API key provided" } }),
    );
    const res = await testProviderConnection("chat", "https://p.test/v1", "sk-x", "m", f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/API key ditolak/);
    expect(res.error).toMatch(/Incorrect API key/);
  });

  it("network error -> ok:false dengan pesan Bahasa Indonesia", async () => {
    const f = mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await testProviderConnection("chat", "https://p.test/v1", "sk-x", "m", f);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Tidak bisa terhubung/);
  });
});

describe("probeErrorMessage — pemetaan status", () => {
  it("401/403/404/429/500 punya pesan spesifik", () => {
    expect(probeErrorMessage(401, null)).toMatch(/API key ditolak/);
    expect(probeErrorMessage(403, null)).toMatch(/Akses ditolak/);
    expect(probeErrorMessage(404, null)).toMatch(/Endpoint tidak ditemukan/);
    expect(probeErrorMessage(429, null)).toMatch(/Terlalu banyak permintaan/);
    expect(probeErrorMessage(503, null)).toMatch(/503/);
  });

  it("abort -> pesan timeout", () => {
    const err = new DOMException("The operation was aborted.", "AbortError");
    expect(probeErrorMessage(null, err)).toMatch(/Waktu habis/);
  });

  it("tanpa vi fake timers: timeout nyata tidak diuji di sini (15 dtk)", () => {
    expect(vi.isMockFunction(vi.fn())).toBe(true); // placeholder: suite ini tidak menunggu timeout
  });
});
