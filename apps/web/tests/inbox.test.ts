import { describe, expect, it } from "vitest";
import {
  chatKind,
  displayName,
  formatPn,
  modeLabel,
  parseImportNumbers,
} from "../src/lib/inbox";

/** Helper presentasi + parsing impor nomor (Task 5). */
describe("chatKind", () => {
  it("membedakan personal, grup, broadcast", () => {
    expect(chatKind("628131742034")).toBe("personal");
    expect(chatKind("group:120363012345")).toBe("group");
    expect(chatKind("broadcast")).toBe("broadcast");
  });
});

describe("displayName & formatPn", () => {
  it("nama kontak diutamakan", () => {
    expect(displayName("628131742034", "Budi")).toBe("Budi");
  });
  it("nomor diformat +62 xxx-xxxx-xxxx", () => {
    expect(displayName("628131742034", null)).toBe("+62 813-1742-034");
    expect(formatPn("08131742034")).toBe("+62 813-1742-034");
  });
  it("kontak semu berlabel jelas", () => {
    expect(displayName("group:120363012345", null)).toBe("Grup WhatsApp");
    expect(displayName("broadcast", null)).toBe("Status WA");
  });
});

describe("modeLabel", () => {
  it("full/semi/off/null -> Full/Semi/Nonaktif/Full", () => {
    expect(modeLabel("full")).toBe("Full");
    expect(modeLabel("semi")).toBe("Semi");
    expect(modeLabel("off")).toBe("Nonaktif");
    expect(modeLabel(null)).toBe("Full");
    expect(modeLabel(undefined)).toBe("Full");
  });
});

describe("parseImportNumbers", () => {
  it("08xx, 628xx, +62 -> ternormalisasi sama, duplikat dibuang", () => {
    const { numbers, failed } = parseImportNumbers(
      "08131742034\n628131742034, +628131742034; 0812 3456 789",
    );
    expect(numbers).toEqual(["628131742034", "628123456789"]);
    expect(failed).toEqual([]);
  });

  it("entri tak dikenali dilaporkan sebagai gagal", () => {
    const { numbers, failed } = parseImportNumbers(
      "08131742034\nnomor-ngawur\n\n   \n+",
    );
    expect(numbers).toEqual(["628131742034"]);
    expect(failed).toEqual(["nomor-ngawur", "+"]);
  });

  it("kontak semu ditolak", () => {
    const { numbers, failed } = parseImportNumbers("group:123\nbroadcast");
    expect(numbers).toEqual([]);
    expect(failed).toEqual(["group:123", "broadcast"]);
  });

  it("input kosong -> dua-duanya kosong", () => {
    expect(parseImportNumbers("  \n,;")).toEqual({ numbers: [], failed: [] });
  });
});
