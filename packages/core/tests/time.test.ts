import { describe, expect, it } from "vitest";
import { formatWIB, isQuietHours, nowWIB } from "../src/time.js";

/** Buat Date dari waktu WIB: "2026-10-06 23:15" WIB -> Date UTC. */
function wib(iso: string): Date {
  // iso: "2026-10-06T23:15" (waktu WIB) -> kurangi 7 jam jadi UTC
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m] = t.split(":").map(Number);
  return new Date(Date.UTC(Y, M - 1, D, h - 7, m));
}

describe("isQuietHours", () => {
  it("default 20.00-08.00 WIB: malam hari = sunyi", () => {
    expect(isQuietHours(wib("2026-10-06T20:00"))).toBe(true);
    expect(isQuietHours(wib("2026-10-06T23:15"))).toBe(true);
    expect(isQuietHours(wib("2026-10-07T03:00"))).toBe(true);
    expect(isQuietHours(wib("2026-10-07T07:59"))).toBe(true);
  });

  it("default 20.00-08.00 WIB: siang hari = tidak sunyi", () => {
    expect(isQuietHours(wib("2026-10-06T08:00"))).toBe(false);
    expect(isQuietHours(wib("2026-10-06T12:00"))).toBe(false);
    expect(isQuietHours(wib("2026-10-06T19:59"))).toBe(false);
  });

  it("rentang kustom yang tidak melewati tengah malam", () => {
    expect(isQuietHours(wib("2026-10-06T22:00"), 22, 23)).toBe(true);
    expect(isQuietHours(wib("2026-10-06T21:00"), 22, 23)).toBe(false);
  });

  it("batas tepat 20.00 dan 08.00", () => {
    expect(isQuietHours(wib("2026-10-06T20:00"))).toBe(true); // inklusif
    expect(isQuietHours(wib("2026-10-07T08:00"))).toBe(false); // eksklusif
  });
});

describe("formatWIB", () => {
  it("memformat ke Bahasa Indonesia + WIB", () => {
    expect(formatWIB(wib("2026-10-06T23:15"))).toBe("6 Okt 2026, 23:15 WIB");
  });

  it("bulan Mei dan Agustus memakai nama Indonesia", () => {
    expect(formatWIB(wib("2026-05-01T09:05"))).toBe("1 Mei 2026, 09:05 WIB");
    expect(formatWIB(wib("2026-08-17T10:00"))).toBe("17 Agu 2026, 10:00 WIB");
  });
});

describe("nowWIB", () => {
  it("mengembalikan Date yang valid", () => {
    const d = nowWIB();
    expect(d).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - d.getTime())).toBeLessThan(1000);
  });
});
