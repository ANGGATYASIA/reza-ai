import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { saveProviderSlot } from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis } from "@/lib/server";

export const dynamic = "force-dynamic";

function testApiEnabled(): boolean {
  return process.env.E2E_TEST_API === "1";
}

/**
 * HANYA UNTUK E2E (E2E_TEST_API=1).
 *
 * POST {baseUrl, apiKey?, model?}: arahkan slot embedding ke server
 * HTTP mock lokal milik file spec (vektor hash deterministik — lihat
 * docs/demo-task-6.md). Memakai saveProviderSlot produksi sehingga
 * jalur getEffectiveProviderConfig -> embedBatch tetap asli.
 */
export async function POST(req: NextRequest) {
  if (!testApiEnabled()) {
    return NextResponse.json({ error: "Tidak ditemukan." }, { status: 404 });
  }
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { baseUrl?: string; apiKey?: string; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body harus JSON." }, { status: 400 });
  }
  if (!body.baseUrl || !/^https?:\/\//.test(body.baseUrl)) {
    return NextResponse.json({ error: "baseUrl tidak valid." }, { status: 400 });
  }

  await saveProviderSlot("embedding", {
    name: "mock-e2e",
    baseUrl: body.baseUrl,
    apiKey: body.apiKey ?? "e2e-test-key",
    model: body.model ?? "mock-embed-1536",
    enabled: true,
  });
  return NextResponse.json({ ok: true });
}
