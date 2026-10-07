import { describe, expect, it } from "vitest";
import {
  decryptSetting,
  encryptSetting,
  maskApiKey,
  parseModelList,
  resolveEffectiveSlot,
  type SlotConfig,
} from "../src/index.js";

/**
 * Unit test Task 3 — provider AI (BYOK).
 * Pure function + crypto saja; tidak butuh database.
 */

const TEST_MASTER_KEY = "c".repeat(64);

function slot(over: Partial<SlotConfig> = {}): SlotConfig {
  return {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-uji",
    model: "gpt-4o-mini",
    enabled: true,
    ...over,
  };
}

describe("maskApiKey — API key tidak pernah tampil utuh", () => {
  it("menampilkan 4 digit terakhir dengan mask", () => {
    expect(maskApiKey("sk-e2e-secret-key-12345")).toEqual({
      masked: "••••2345",
      keySet: true,
    });
  });

  it("key kosong -> keySet false dan masked kosong", () => {
    expect(maskApiKey("")).toEqual({ masked: "", keySet: false });
    expect(maskApiKey(null)).toEqual({ masked: "", keySet: false });
    expect(maskApiKey(undefined)).toEqual({ masked: "", keySet: false });
  });

  it("key pendek (<=4 char) tetap di-mask, tidak tampil utuh", () => {
    const { masked, keySet } = maskApiKey("ab");
    expect(keySet).toBe(true);
    expect(masked).toBe("••••ab");
  });
});

describe("parseModelList — parser respons GET /models", () => {
  it("format OpenAI {data:[{id}]} -> daftar id", () => {
    expect(
      parseModelList({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    ).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("payload rusak -> [] (tidak throw)", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList("teks")).toEqual([]);
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList({ data: "bukan-array" })).toEqual([]);
    expect(parseModelList({ data: [{ nama: "x" }, { id: 42 }] })).toEqual([]);
  });

  it("id duplikat dibuang, id kosong dilewati", () => {
    expect(
      parseModelList({ data: [{ id: "a" }, { id: "a" }, { id: "" }, { id: "b" }] }),
    ).toEqual(["a", "b"]);
  });
});

describe("resolveEffectiveSlot — logika inherit 'Sama dengan Chat'", () => {
  const chat = slot({ name: "ChatProv", model: "model-chat" });
  const own = slot({ name: "EmbProv", model: "model-emb" });

  it("slot chat tidak pernah inherit", () => {
    const eff = resolveEffectiveSlot("chat", own, chat, true);
    expect(eff?.name).toBe("EmbProv");
    expect(eff?.inherited).toBe(false);
  });

  it("inherit=true -> pakai config chat", () => {
    const eff = resolveEffectiveSlot("embedding", own, chat, true);
    expect(eff?.name).toBe("ChatProv");
    expect(eff?.model).toBe("model-chat");
    expect(eff?.apiKey).toBe(chat.apiKey);
    expect(eff?.inherited).toBe(true);
    expect(eff?.slot).toBe("embedding");
  });

  it("inherit=false -> pakai config sendiri", () => {
    const eff = resolveEffectiveSlot("embedding", own, chat, false);
    expect(eff?.name).toBe("EmbProv");
    expect(eff?.inherited).toBe(false);
  });

  it("inherit=true tapi chat belum dikonfigurasi -> null", () => {
    expect(resolveEffectiveSlot("vision", own, null, true)).toBeNull();
  });

  it("config sendiri kosong dan tidak inherit -> null", () => {
    expect(resolveEffectiveSlot("transcription", null, chat, false)).toBeNull();
  });
});

describe("enkripsi API key — round-trip + tamper detection", () => {
  it("API key gaya OpenAI bisa dienkripsi lalu didekripsi utuh", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const key = "sk-proj-abcdef1234567890XYZ";
    const { encryptedValue, iv } = encryptSetting(key);
    // Ciphertext tidak mengandung key asli.
    expect(encryptedValue).not.toContain(key);
    expect(decryptSetting(encryptedValue, iv)).toBe(key);
  });

  it("ciphertext API key yang dirusak gagal didekripsi (GCM auth tag)", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const { encryptedValue, iv } = encryptSetting("sk-rahasia-123");
    const raw = Buffer.from(encryptedValue, "base64");
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptSetting(raw.toString("base64"), iv)).toThrow();
  });

  it("iv yang dirusak gagal didekripsi", () => {
    process.env.MASTER_KEY = TEST_MASTER_KEY;
    const { encryptedValue, iv } = encryptSetting("sk-rahasia-123");
    const badIv = Buffer.from(iv, "base64");
    badIv[0] ^= 0xff;
    expect(() => decryptSetting(encryptedValue, badIv.toString("base64"))).toThrow();
  });
});
