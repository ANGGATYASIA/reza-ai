import { describe, expect, it } from "vitest";
import { FakeGateway, type InboundMessage } from "../src/index.js";

/** (e) FakeGateway: send tercatat, presence & downloadMedia terpanggil. */
describe("FakeGateway", () => {
  it("send tercatat + butuh connect()", async () => {
    const gw = new FakeGateway();
    await expect(gw.send("62812", "halo")).rejects.toThrow(/connect/);
    await gw.connect();
    const r1 = await gw.send("6281234567890", "Halo!");
    const r2 = await gw.send("6281234567890", "Lanjut?");
    expect(r1.messageId).not.toBe(r2.messageId);
    expect(gw.sentTexts).toEqual([
      { to: "6281234567890", body: "Halo!", id: r1.messageId },
      { to: "6281234567890", body: "Lanjut?", id: r2.messageId },
    ]);
    const m = await gw.sendMedia("62812", "/tmp/foto.jpg", "lihat ini");
    expect(gw.sentMedia[0]).toMatchObject({
      to: "62812",
      path: "/tmp/foto.jpg",
      caption: "lihat ini",
      id: m.messageId,
    });
  });

  it("presence & downloadMedia tercatat", async () => {
    const gw = new FakeGateway();
    await gw.connect();
    await gw.presence("62812", "composing");
    await gw.presence("62812", "paused");
    expect(gw.presenceCalls).toEqual([
      { to: "62812", state: "composing" },
      { to: "62812", state: "paused" },
    ]);

    const msg: InboundMessage = { id: "m1", from: "62812", timestamp: 1 };
    const buf = await gw.downloadMedia(msg);
    expect(gw.downloadCalls).toEqual([msg]);
    expect(buf.toString()).toContain("m1");
  });

  it("onMessage + simulateIncoming, onConnectionUpdate", async () => {
    const gw = new FakeGateway();
    const received: InboundMessage[] = [];
    gw.onMessage((m) => {
      received.push(m);
    });
    const connStatuses: string[] = [];
    gw.onConnectionUpdate((s) => connStatuses.push(s));

    await gw.connect();
    await gw.simulateIncoming({ id: "m2", from: "62899", body: "tes", timestamp: 2 });
    await gw.disconnect();

    expect(received).toHaveLength(1);
    expect(received[0].body).toBe("tes");
    expect(connStatuses).toEqual(["open", "close"]);
  });

  it("wasRecentlySent: id terkirim dikenali, id lain tidak", async () => {
    const gw = new FakeGateway();
    await gw.connect();
    const { messageId } = await gw.send("62812", "halo");
    expect(gw.wasRecentlySent(messageId)).toBe(true);
    expect(gw.wasRecentlySent("id-asing")).toBe(false);
    expect(gw.wasRecentlySent(messageId, 0)).toBe(false);
    gw.reset();
    expect(gw.wasRecentlySent(messageId)).toBe(false);
  });
});
