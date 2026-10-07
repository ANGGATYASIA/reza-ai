import { prisma } from "./db.js";
import { encryptSetting, decryptSetting } from "./crypto.js";
import type { ProviderSlot } from "@prisma/client";

// ============================================================
// Reza AI — konfigurasi provider AI (BYOK) + pengaturan umum.
//
// Penyimpanan:
// - API key per slot -> tabel Setting, key "provider.apikey.<slot>",
//   terenkripsi AES-256-GCM via encryptSetting() (MASTER_KEY dari env).
//   API key TIDAK PERNAH dikirim balik ke UI; hanya versi masked.
// - Flag inherit "Sama dengan Chat" untuk slot non-chat ->
//   Setting "provider.inherit.<slot>" = "1" / "0".
// - Baris Provider (satu per slot) menyimpan name/baseUrl/model/enabled;
//   apiKeySettingKey menunjuk ke key Setting di atas.
// - Pengaturan umum (nama persona, gaya bahasa, nomor WA owner, mode AI,
//   jam follow up, debounce/jeda balasan, threshold handoff, jeda manual)
//   -> Setting "general.<nama>", terenkripsi seragam.
//
// Task 4 (worker WhatsApp) membaca config efektif per slot lewat
// getEffectiveProviderConfig(slot): sudah termasuk resolusi inherit
// dan dekripsi API key. Jangan baca tabel Provider langsung dari worker.
// ============================================================

export const PROVIDER_SLOTS = ["chat", "embedding", "vision", "transcription"] as const;
export type ProviderSlotName = (typeof PROVIDER_SLOTS)[number];

/** Label Bahasa Indonesia untuk tiap slot (dipakai UI). */
export const SLOT_LABELS: Record<ProviderSlotName, string> = {
  chat: "Chat",
  embedding: "Embedding",
  vision: "Vision",
  transcription: "Transkripsi",
};

export const API_KEY_SETTING_PREFIX = "provider.apikey.";
export const INHERIT_SETTING_PREFIX = "provider.inherit.";

export const apiKeySettingKey = (slot: ProviderSlotName): string =>
  `${API_KEY_SETTING_PREFIX}${slot}`;
export const inheritSettingKey = (slot: ProviderSlotName): string =>
  `${INHERIT_SETTING_PREFIX}${slot}`;

export interface GeneralSettings {
  personaName: string;
  personaTone: "santai" | "profesional-santai" | "formal";
  ownerWaNumber: string;
  aiMode: "full" | "semi" | "off";
  followupStart: string; // "HH:MM"
  followupEnd: string; // "HH:MM"
  // --- Pengaturan pipeline AI (Task 8) ---
  /** Jeda debounce per chat sebelum AI mulai membalas (detik). */
  debounceSec: number;
  /** Jeda "mengetik" sebelum balasan terkirim: batas bawah (detik). */
  replyDelayMinSec: number;
  /** Jeda "mengetik" sebelum balasan terkirim: batas atas (detik). */
  replyDelayMaxSec: number;
  /** Confidence di bawah ini -> handoff ke Reza (0..1). */
  handoffConfidenceThreshold: number;
  /** Lama AI dijeda otomatis setelah Reza membalas manual dari HP (jam). */
  manualPauseHours: number;
}

export const GENERAL_DEFAULTS: GeneralSettings = {
  personaName: "Reza",
  personaTone: "profesional-santai",
  ownerWaNumber: "082114812842",
  aiMode: "full",
  followupStart: "08:00",
  followupEnd: "20:00",
  debounceSec: 10,
  replyDelayMinSec: 30,
  replyDelayMaxSec: 120,
  handoffConfidenceThreshold: 0.5,
  manualPauseHours: 4,
};

const GENERAL_KEYS: Record<keyof GeneralSettings, string> = {
  personaName: "general.personaName",
  personaTone: "general.personaTone",
  ownerWaNumber: "general.ownerWaNumber",
  aiMode: "general.aiMode",
  followupStart: "general.followupStart",
  followupEnd: "general.followupEnd",
  debounceSec: "general.debounceSec",
  replyDelayMinSec: "general.replyDelayMinSec",
  replyDelayMaxSec: "general.replyDelayMaxSec",
  handoffConfidenceThreshold: "general.handoffConfidenceThreshold",
  manualPauseHours: "general.manualPauseHours",
};

/**
 * Field numerik + batas validnya. Nilai di luar batas (atau bukan angka)
 * dikembalikan ke default — pengaturan rusak tidak boleh merusak pipeline.
 */
const GENERAL_NUMBER_RANGES: Partial<
  Record<keyof GeneralSettings, [number, number]>
> = {
  debounceSec: [0, 600],
  replyDelayMinSec: [0, 3600],
  replyDelayMaxSec: [0, 3600],
  handoffConfidenceThreshold: [0, 1],
  manualPauseHours: [0, 72],
};

function parseBoundedSetting(
  field: keyof GeneralSettings,
  raw: string,
): number {
  const def = GENERAL_DEFAULTS[field] as number;
  const range = GENERAL_NUMBER_RANGES[field];
  if (!range) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const [min, max] = range;
  if (n < min || n > max) return def;
  return n;
}

/**
 * Masking API key untuk UI: tampilkan "••••" + 4 karakter terakhir.
 * Key utuh tidak pernah keluar dari server lewat fungsi ini.
 */
export function maskApiKey(key: string | null | undefined): { masked: string; keySet: boolean } {
  if (!key) return { masked: "", keySet: false };
  const tail = key.length > 4 ? key.slice(-4) : key;
  return { masked: `••••${tail}`, keySet: true };
}

/**
 * Parser daftar model dari respons `GET {baseUrl}/models`.
 * Format OpenAI: { data: [{ id: "gpt-4o" }, ...] }.
 * Tahan terhadap payload rusak: kembalikan [] bila tak bisa diparse.
 */
export function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

// ---------------- Baca/tulis Setting terenkripsi ----------------

/** Baca Setting lalu dekripsi; null bila key belum ada. */
export async function getSettingDecrypted(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  return decryptSetting(row.encryptedValue, row.iv);
}

/** Tulis Setting (upsert) dengan nilai terenkripsi. */
export async function setSettingEncrypted(key: string, plaintext: string): Promise<void> {
  const { encryptedValue, iv } = encryptSetting(plaintext);
  await prisma.setting.upsert({
    where: { key },
    create: { key, encryptedValue, iv },
    update: { encryptedValue, iv },
  });
}

// ---------------- Pengaturan umum ----------------

export async function getGeneralSettings(): Promise<GeneralSettings> {
  const out = { ...GENERAL_DEFAULTS };
  for (const [field, key] of Object.entries(GENERAL_KEYS) as Array<
    [keyof GeneralSettings, string]
  >) {
    const value = await getSettingDecrypted(key);
    if (value === null || value === "") continue;
    if (GENERAL_NUMBER_RANGES[field]) {
      (out as Record<string, unknown>)[field] = parseBoundedSetting(
        field,
        value,
      );
    } else {
      (out as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

export async function saveGeneralSettings(input: Partial<GeneralSettings>): Promise<void> {
  for (const [field, key] of Object.entries(GENERAL_KEYS) as Array<
    [keyof GeneralSettings, string]
  >) {
    const value = input[field];
    if (value !== undefined) await setSettingEncrypted(key, String(value));
  }
}

// ---------------- Provider per slot ----------------

export interface SlotConfig {
  name: string;
  baseUrl: string;
  /** API key terdekripsi (string kosong bila belum diisi). */
  apiKey: string;
  model: string;
  enabled: boolean;
}

export interface ProviderSummary {
  slot: ProviderSlotName;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  keySet: boolean;
  model: string;
  enabled: boolean;
  /** true = slot ini mengikuti konfigurasi slot Chat. */
  inherit: boolean;
}

export interface EffectiveProviderConfig extends SlotConfig {
  slot: ProviderSlotName;
  /** true bila config ini diwarisi dari slot Chat. */
  inherited: boolean;
}

/**
 * Logika inherit murni (tanpa DB) — bisa di-unit-test langsung.
 * Slot non-chat dengan inherit=true memakai config slot Chat apa adanya.
 */
export function resolveEffectiveSlot(
  slot: ProviderSlotName,
  own: SlotConfig | null,
  chat: SlotConfig | null,
  inherit: boolean,
): EffectiveProviderConfig | null {
  const source = slot !== "chat" && inherit ? chat : own;
  if (!source) return null;
  return { ...source, slot, inherited: slot !== "chat" && inherit };
}

async function readSlotConfig(slot: ProviderSlotName): Promise<SlotConfig | null> {
  const row = await prisma.provider.findFirst({
    where: { slot: slot as ProviderSlot },
    include: { apiKeySetting: true },
  });
  if (!row) return null;
  let apiKey = "";
  try {
    apiKey = decryptSetting(row.apiKeySetting.encryptedValue, row.apiKeySetting.iv);
  } catch {
    // Key rusak / MASTER_KEY berubah: anggap belum diisi, jangan bocorkan.
    apiKey = "";
  }
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey,
    model: row.model,
    enabled: row.enabled,
  };
}

async function readInherit(slot: ProviderSlotName): Promise<boolean> {
  if (slot === "chat") return false;
  return (await getSettingDecrypted(inheritSettingKey(slot))) === "1";
}

/**
 * Config efektif per slot untuk pemakaian runtime (Task 4/worker):
 * sudah termasuk resolusi inherit + dekripsi API key.
 * Kembalikan null bila slot belum dikonfigurasi.
 */
export async function getEffectiveProviderConfig(
  slot: ProviderSlotName,
): Promise<EffectiveProviderConfig | null> {
  const own = await readSlotConfig(slot);
  if (slot === "chat") return resolveEffectiveSlot(slot, own, null, false);
  const inherit = await readInherit(slot);
  const chat = inherit ? await readSlotConfig("chat") : null;
  return resolveEffectiveSlot(slot, own, chat, inherit);
}

/** Ringkasan semua slot untuk UI — API key selalu masked, tak pernah utuh. */
export async function listProviderSummaries(): Promise<ProviderSummary[]> {
  const summaries: ProviderSummary[] = [];
  for (const slot of PROVIDER_SLOTS) {
    const cfg = await readSlotConfig(slot);
    const inherit = await readInherit(slot);
    const { masked, keySet } = maskApiKey(cfg?.apiKey);
    summaries.push({
      slot,
      name: cfg?.name ?? "",
      baseUrl: cfg?.baseUrl ?? "",
      apiKeyMasked: masked,
      keySet,
      model: cfg?.model ?? "",
      enabled: cfg?.enabled ?? true,
      inherit,
    });
  }
  return summaries;
}

export interface SaveSlotInput {
  name: string;
  baseUrl: string;
  /**
   * API key baru (plaintext). undefined atau string kosong = pertahankan
   * key lama yang tersimpan (bila ada).
   */
  apiKey?: string;
  model: string;
  enabled: boolean;
  /** Hanya relevan untuk slot non-chat. */
  inherit?: boolean;
}

/**
 * Simpan konfigurasi satu slot. API key baru dienkripsi ke Setting;
 * key lama dipertahankan bila apiKey dikosongkan/diabaikan.
 */
export async function saveProviderSlot(slot: ProviderSlotName, input: SaveSlotInput): Promise<void> {
  const keyKey = apiKeySettingKey(slot);

  if (input.apiKey !== undefined && input.apiKey !== "") {
    await setSettingEncrypted(keyKey, input.apiKey);
  } else {
    // Pastikan baris Setting ada (nilai kosong terenkripsi) supaya
    // relasi Provider -> Setting selalu valid.
    const existing = await prisma.setting.findUnique({ where: { key: keyKey } });
    if (!existing) await setSettingEncrypted(keyKey, "");
  }

  const existing = await prisma.provider.findFirst({ where: { slot: slot as ProviderSlot } });
  const data = {
    name: input.name,
    baseUrl: input.baseUrl,
    apiKeySettingKey: keyKey,
    model: input.model,
    enabled: input.enabled,
  };
  if (existing) {
    await prisma.provider.update({ where: { id: existing.id }, data });
  } else {
    await prisma.provider.create({ data: { slot: slot as ProviderSlot, ...data } });
  }

  if (slot !== "chat" && input.inherit !== undefined) {
    await setSettingEncrypted(inheritSettingKey(slot), input.inherit ? "1" : "0");
  }
}
