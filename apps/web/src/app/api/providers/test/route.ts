import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PROVIDER_SLOTS,
  getEffectiveProviderConfig,
  type ProviderSlotName,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { testProviderConnection } from "@/lib/provider-probe";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/test — uji koneksi sungguhan ke provider.
 * Body: { slot, baseUrl, apiKey?, model }.
 * - chat       -> POST /chat/completions (ping)
 * - embedding  -> POST /embeddings (input "tes")
 * - vision     -> POST /chat/completions (ping teks)
 * - transcription -> GET /models (cek konektivitas; endpoint transkripsi
 *   butuh berkas audio sehingga tidak di-POST)
 * Bila apiKey dikosongkan, pakai key tersimpan (bila ada).
 * Respons: { ok, latencyMs, detail } atau { ok:false, error }.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { slot?: string; baseUrl?: string; apiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const slot = body.slot as ProviderSlotName;
  if (!PROVIDER_SLOTS.includes(slot))
    return NextResponse.json({ error: "Slot tidak dikenal." }, { status: 400 });

  const baseUrl = (body.baseUrl ?? "").trim();
  if (!baseUrl)
    return NextResponse.json({ error: "Isi base URL dulu sebelum tes koneksi." }, { status: 400 });

  const model = (body.model ?? "").trim();
  if (slot !== "transcription" && !model)
    return NextResponse.json(
      { error: "Pilih model dulu sebelum tes koneksi." },
      { status: 400 },
    );

  let apiKey = (body.apiKey ?? "").trim() || undefined;
  if (!apiKey) {
    try {
      const cfg = await getEffectiveProviderConfig(slot);
      if (cfg?.apiKey) apiKey = cfg.apiKey;
    } catch {
      /* abaikan — lanjut tanpa key */
    }
  }

  const result = await testProviderConnection(slot, baseUrl, apiKey, model);
  return NextResponse.json(result);
}
