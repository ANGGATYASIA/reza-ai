import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getEffectiveProviderConfig, type ProviderSlotName } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";
import { detectModels } from "@/lib/provider-probe";

export const dynamic = "force-dynamic";

/**
 * POST /api/providers/detect — deteksi daftar model dari provider.
 * Body: { slot, baseUrl, apiKey? }.
 * Bila apiKey dikosongkan, pakai key tersimpan (bila ada) supaya
 * tombol "Deteksi model" bisa dipakai tanpa mengetik ulang key.
 * Respons: { models: [...] } atau { error: "..." } (400).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { slot?: string; baseUrl?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body harus JSON yang valid." }, { status: 400 });
  }

  const baseUrl = (body.baseUrl ?? "").trim();
  if (!baseUrl)
    return NextResponse.json({ error: "Isi base URL dulu sebelum deteksi model." }, { status: 400 });
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return NextResponse.json(
        { error: "Base URL harus diawali http:// atau https://." },
        { status: 400 },
      );
  } catch {
    return NextResponse.json({ error: "Base URL tidak valid." }, { status: 400 });
  }

  // Fallback ke key tersimpan bila field dikosongkan.
  let apiKey = (body.apiKey ?? "").trim() || undefined;
  if (!apiKey && body.slot) {
    try {
      const cfg = await getEffectiveProviderConfig(body.slot as ProviderSlotName);
      if (cfg?.apiKey) apiKey = cfg.apiKey;
    } catch {
      /* abaikan — lanjut tanpa key */
    }
  }

  const result = await detectModels(baseUrl, apiKey);
  if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ models: result.models });
}
