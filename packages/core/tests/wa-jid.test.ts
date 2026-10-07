import { describe, expect, it } from "vitest";
import {
  isBroadcastJid,
  isGroupJid,
  lidToJid,
  normalizeJid,
  normalizePn,
  pnToJid,
} from "../src/index.js";

/** (d) normalizeJid untuk @s.whatsapp.net vs @lid. */
describe("normalizeJid", () => {
  it("JID nomor HP -> pn", () => {
    expect(normalizeJid("6281234567890@s.whatsapp.net")).toEqual({
      pn: "6281234567890",
    });
  });

  it("JID @lid -> lid, pn kosong (mapping diisi Task 5 via Contact)", () => {
    expect(normalizeJid("123456789012345@lid")).toEqual({
      pn: "",
      lid: "123456789012345",
    });
  });

  it("sufiks device dipangkas", () => {
    expect(normalizeJid("6281234567890:27@s.whatsapp.net")).toEqual({
      pn: "6281234567890",
    });
  });

  it("grup & broadcast -> pn kosong", () => {
    expect(normalizeJid("120363012345@g.us")).toEqual({ pn: "" });
    expect(normalizeJid("status@broadcast")).toEqual({ pn: "" });
  });
});

describe("helper JID", () => {
  it("pnToJid / lidToJid / isGroupJid", () => {
    expect(pnToJid("6281234567890")).toBe("6281234567890@s.whatsapp.net");
    expect(pnToJid("+62 812-3456-7890")).toBe("6281234567890@s.whatsapp.net");
    expect(lidToJid("123456789012345")).toBe("123456789012345@lid");
    expect(isGroupJid("120363012345@g.us")).toBe(true);
    expect(isGroupJid("6281234567890@s.whatsapp.net")).toBe(false);
  });

  it("isBroadcastJid", () => {
    expect(isBroadcastJid("status@broadcast")).toBe(true);
    expect(isBroadcastJid("123@broadcast")).toBe(true);
    expect(isBroadcastJid("120363012345@g.us")).toBe(false);
    expect(isBroadcastJid("6281234567890@s.whatsapp.net")).toBe(false);
  });
});

describe("normalizePn", () => {
  it("08xx, 628xx, +62, dan format acak -> ternormalisasi sama", () => {
    expect(normalizePn("08131742034")).toBe("628131742034");
    expect(normalizePn("628131742034")).toBe("628131742034");
    expect(normalizePn("+628131742034")).toBe("628131742034");
    expect(normalizePn("+62 813-1742-034")).toBe("628131742034");
    expect(normalizePn(" 0813 1742 034 ")).toBe("628131742034");
  });

  it("kosong / tanpa digit -> string kosong", () => {
    expect(normalizePn("")).toBe("");
    expect(normalizePn(null)).toBe("");
    expect(normalizePn(undefined)).toBe("");
    expect(normalizePn("abc")).toBe("");
  });
});
