import { parseModelList, type ProviderSlotName } from "@reza-ai/core";

// ============================================================
// Reza AI — probe provider AI (deteksi model & tes koneksi).
// Dijalankan server-side dari Route Handler /api/providers/*.
// Parameter fetchImpl bisa di-inject untuk unit test (mock fetch);
// default-nya fetch global Node.
// ============================================================

const PROBE_TIMEOUT_MS = 15_000;

type FetchImpl = typeof fetch;

export interface DetectResult {
  models?: string[];
  error?: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function withTimeout(): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError"
    : err instanceof Error && err.name === "AbortError";
}

/** Petakan kegagalan HTTP/jaringan ke pesan Bahasa Indonesia yang jelas. */
export function probeErrorMessage(status: number | null, err: unknown): string {
  if (status === null) {
    if (isAbort(err))
      return "Waktu habis: server provider tidak merespons dalam 15 detik. Periksa base URL.";
    return (
      "Tidak bisa terhubung ke alamat ini. Periksa base URL " +
      "(harus diawali http:// atau https://) dan koneksi jaringan server."
    );
  }
  switch (status) {
    case 401:
      return "API key ditolak server (401). Periksa kembali API key yang dimasukkan.";
    case 403:
      return "Akses ditolak server (403). API key mungkin tidak punya izin untuk endpoint ini.";
    case 404:
      return "Endpoint tidak ditemukan (404). Periksa base URL. Biasanya tanpa akhiran /models atau /chat.";
    case 429:
      return "Terlalu banyak permintaan (429). Tunggu sebentar, lalu coba lagi.";
    default:
      if (status >= 500)
        return `Server provider bermasalah (kode ${status}). Coba lagi beberapa saat lagi.`;
      return `Server merespons kode ${status}. Periksa base URL dan model yang dipilih.`;
  }
}

/**
 * Deteksi model: GET {baseUrl}/models -> daftar id model.
 * Format OpenAI ({data:[{id}]}) diparse via parseModelList().
 */
export async function detectModels(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<DetectResult> {
  const { signal, cancel } = withTimeout();
  try {
    const res = await fetchImpl(joinUrl(baseUrl, "/models"), {
      headers: authHeaders(apiKey),
      signal,
    });
    if (!res.ok) return { error: probeErrorMessage(res.status, null) };
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { error: "Server tidak mengembalikan JSON. Pastikan base URL menunjuk ke API yang kompatibel OpenAI." };
    }
    const models = parseModelList(payload);
    if (models.length === 0)
      return { error: "Server merespons, tapi tidak ada daftar model di dalamnya." };
    return { models };
  } catch (err) {
    return { error: probeErrorMessage(null, err) };
  } finally {
    cancel();
  }
}

/**
 * Tes koneksi sungguhan per slot:
 * - chat        -> POST /chat/completions {model, messages:[{user,"ping"}]}
 * - embedding   -> POST /embeddings {model, input:"tes"}
 * - vision      -> POST /chat/completions (ping teks; endpoint vision
 *                  OpenAI-compatible menerima lewat sini)
 * - transcription -> GET /models (cek konektivitas + auth; endpoint
 *                  transkripsi butuh berkas audio sehingga tidak di-POST)
 */
export async function testProviderConnection(
  slot: ProviderSlotName,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  fetchImpl: FetchImpl = fetch,
): Promise<TestResult> {
  if (slot === "transcription") {
    const started = Date.now();
    const { signal, cancel } = withTimeout();
    try {
      const res = await fetchImpl(joinUrl(baseUrl, "/models"), {
        headers: authHeaders(apiKey),
        signal,
      });
      if (!res.ok) return { ok: false, error: probeErrorMessage(res.status, null) };
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail:
          "Koneksi dan API key valid. Endpoint transkripsi (/audio/transcriptions) " +
          "butuh berkas audio sehingga tidak diuji di sini. Yang dicek hanya konektivitasnya.",
      };
    } catch (err) {
      return { ok: false, error: probeErrorMessage(null, err) };
    } finally {
      cancel();
    }
  }

  const path = slot === "embedding" ? "/embeddings" : "/chat/completions";
  const body =
    slot === "embedding"
      ? { model, input: "tes" }
      : { model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 };

  const started = Date.now();
  const { signal, cancel } = withTimeout();
  try {
    const res = await fetchImpl(joinUrl(baseUrl, path), {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      // Coba ambil pesan galat dari body provider (format OpenAI).
      let hint = "";
      try {
        const payload = (await res.json()) as { error?: { message?: string } };
        if (payload?.error?.message) hint = `: ${payload.error.message}`;
      } catch {
        /* abaikan */
      }
      return { ok: false, error: probeErrorMessage(res.status, null) + hint };
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      detail:
        slot === "embedding"
          ? "Endpoint embeddings merespons. Siap dipakai untuk knowledge base."
          : slot === "vision"
            ? "Endpoint chat/completions merespons untuk model vision ini."
            : "Model merespons ping. Slot chat siap dipakai.",
    };
  } catch (err) {
    return { ok: false, error: probeErrorMessage(null, err) };
  } finally {
    cancel();
  }
}
