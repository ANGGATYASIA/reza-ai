import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  PROVIDER_SLOTS,
  getGeneralSettings,
  listProviderSummaries,
  maybeEnqueueReindex,
  saveGeneralSettings,
  saveProviderSlot,
  type ProviderSlotName,
} from "@reza-ai/core";
import { requireAdmin } from "@/lib/auth";
import { getRedis, prisma } from "@/lib/server";

export const dynamic = "force-dynamic";

const TONES = ["santai", "profesional-santai", "formal"];
const AI_MODES = ["full", "semi", "off"];
const TIME_RE = /^\d{2}:\d{2}$/;

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/settings — seluruh pengaturan untuk UI.
 * API key TIDAK PERNAH dikirim utuh: hanya versi masked
 * ("••••" + 4 digit terakhir) + flag keySet.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  const [general, providers] = await Promise.all([
    getGeneralSettings(),
    listProviderSummaries(),
  ]);
  return NextResponse.json({ general, providers });
}

interface SlotPayload {
  name?: string;
  baseUrl?: string;
  /** Plaintext key baru; kosong/undefined = pertahankan key lama. */
  apiKey?: string;
  model?: string;
  enabled?: boolean;
  inherit?: boolean;
}

function validateSlot(slot: ProviderSlotName, p: SlotPayload): string | null {
  if (p.name !== undefined && p.name.length > 120) return `Nama slot ${slot} terlalu panjang.`;
  if (p.baseUrl !== undefined && p.baseUrl !== "") {
    try {
      const url = new URL(p.baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        return `Base URL slot ${slot} harus diawali http:// atau https://.`;
    } catch {
      return `Base URL slot ${slot} tidak valid.`;
    }
  }
  if (p.model !== undefined && p.model.length > 120) return `Model slot ${slot} terlalu panjang.`;
  return null;
}

/**
 * PUT /api/settings — simpan pengaturan.
 * Body: { general: {...}, providers: { chat: {...}, embedding: {...}, ... } }.
 * API key baru dienkripsi ke tabel Setting; key lama dipertahankan
 * bila field apiKey dikosongkan.
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req, getRedis());
  if (!auth.ok) return auth.response;

  let body: { general?: Record<string, unknown>; providers?: Record<string, SlotPayload> };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body harus JSON yang valid.");
  }

  // ---- Validasi umum ----
  const g = body.general ?? {};
  if (g.personaName !== undefined && (typeof g.personaName !== "string" || g.personaName.length > 60))
    return badRequest("Nama persona maksimal 60 karakter.");
  if (g.personaTone !== undefined && !TONES.includes(String(g.personaTone)))
    return badRequest("Gaya bahasa tidak dikenal.");
  if (
    g.ownerWaNumber !== undefined &&
    !/^[0-9]{8,16}$/.test(String(g.ownerWaNumber).replace(/[\s+-]/g, ""))
  )
    return badRequest("Nomor WA owner harus 8–16 digit angka.");
  if (g.aiMode !== undefined && !AI_MODES.includes(String(g.aiMode)))
    return badRequest("Mode AI tidak dikenal.");
  for (const k of ["followupStart", "followupEnd"] as const) {
    if (g[k] !== undefined && !TIME_RE.test(String(g[k])))
      return badRequest("Jam follow up harus format JJ:MM, mis. 08:00.");
  }
  // Task 8 — pengaturan pipeline AI: angka dalam batas wajar.
  const NUM_BOUNDS: Record<string, [number, number]> = {
    debounceSec: [0, 600],
    replyDelayMinSec: [0, 3600],
    replyDelayMaxSec: [0, 3600],
    handoffConfidenceThreshold: [0, 1],
    manualPauseHours: [0, 72],
  };
  for (const [k, [min, max]] of Object.entries(NUM_BOUNDS)) {
    if (g[k] !== undefined) {
      const n = Number(g[k]);
      if (!Number.isFinite(n) || n < min || n > max)
        return badRequest(`${k} harus angka antara ${min} dan ${max}.`);
    }
  }
  if (
    g.replyDelayMinSec !== undefined &&
    g.replyDelayMaxSec !== undefined &&
    Number(g.replyDelayMinSec) > Number(g.replyDelayMaxSec)
  )
    return badRequest("Batas bawah jeda balasan tidak boleh melebihi batas atas.");

  // ---- Validasi provider ----
  const slots = body.providers ?? {};
  for (const slot of PROVIDER_SLOTS) {
    const p = slots[slot];
    if (!p) continue;
    const err = validateSlot(slot, p);
    if (err) return badRequest(err);
    if (slot === "chat" && p.inherit)
      return badRequest("Slot Chat tidak bisa mewarisi slot lain.");
  }

  // ---- Simpan ----
  // Catat model embedding lama DULU: bila berubah, antrekan reindex
  // (Task 6) setelah penyimpanan selesai.
  const oldEmbeddingModel = (
    await prisma.provider.findFirst({ where: { slot: "embedding" } })
  )?.model ?? null;

  await saveGeneralSettings({
    personaName: g.personaName as string | undefined,
    personaTone: g.personaTone as "santai" | "profesional-santai" | "formal" | undefined,
    ownerWaNumber:
      g.ownerWaNumber !== undefined
        ? String(g.ownerWaNumber).replace(/[\s+-]/g, "")
        : undefined,
    aiMode: g.aiMode as "full" | "semi" | "off" | undefined,
    followupStart: g.followupStart as string | undefined,
    followupEnd: g.followupEnd as string | undefined,
    debounceSec: g.debounceSec !== undefined ? Number(g.debounceSec) : undefined,
    replyDelayMinSec:
      g.replyDelayMinSec !== undefined ? Number(g.replyDelayMinSec) : undefined,
    replyDelayMaxSec:
      g.replyDelayMaxSec !== undefined ? Number(g.replyDelayMaxSec) : undefined,
    handoffConfidenceThreshold:
      g.handoffConfidenceThreshold !== undefined
        ? Number(g.handoffConfidenceThreshold)
        : undefined,
    manualPauseHours:
      g.manualPauseHours !== undefined ? Number(g.manualPauseHours) : undefined,
  });

  for (const slot of PROVIDER_SLOTS) {
    const p = slots[slot];
    if (!p) continue;
    await saveProviderSlot(slot, {
      name: p.name ?? "",
      baseUrl: p.baseUrl ?? "",
      apiKey: p.apiKey,
      model: p.model ?? "",
      enabled: p.enabled ?? true,
      inherit: p.inherit,
    });
  }

  // Task 6: model embedding berubah -> embed ulang seluruh chunk.
  // Kegagalan enqueue tidak menggagalkan penyimpanan pengaturan.
  let reindexEnqueued = false;
  const newEmbeddingModel = (
    await prisma.provider.findFirst({ where: { slot: "embedding" } })
  )?.model ?? null;
  try {
    reindexEnqueued = await maybeEnqueueReindex(
      getRedis(),
      oldEmbeddingModel,
      newEmbeddingModel,
    );
    if (reindexEnqueued) {
      console.log(
        `[settings] model embedding berubah (${oldEmbeddingModel} -> ${newEmbeddingModel}): job reindex diantrekan.`,
      );
    }
  } catch (err) {
    console.error("[settings] gagal mengantrekan reindex:", (err as Error).message);
  }

  return NextResponse.json({ ok: true, reindexEnqueued });
}
