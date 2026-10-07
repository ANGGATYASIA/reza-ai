import type Redis from "ioredis";
import RedisMock from "ioredis-mock";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BaileysGateway,
  WA_RESTRICTED_KEY,
  type AuthenticationState,
  type BaileysDeps,
  type InboundMessage,
  type WaStatusPayload,
} from "../src/index.js";
import { FakeBaileysSocket } from "./fake-baileys.js";

/**
 * Unit test BaileysGateway dengan socket palsu (tanpa jaringan/QR):
 * state machine koneksi, guard reconnect, loggedOut, error 463,
 * dan normalisasi pesan masuk.
 */

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

let redis: Redis;
let authDir: string;
let published: WaStatusPayload[];
let sockets: FakeBaileysSocket[];
let deps: BaileysDeps;

function makeGateway(): BaileysGateway {
  return new BaileysGateway({
    redis,
    authDir,
    publish: (p) => {
      published.push({ ...p });
    },
    deps,
    reconnectDelayMs: () => 0, // reconnect deterministik di test
  });
}

beforeEach(() => {
  redis = new RedisMock() as unknown as Redis;
  authDir = mkdtempSync(join(tmpdir(), "wa-auth-test-"));
  published = [];
  sockets = [];
  deps = {
    makeWASocket: (opts) => {
      const s = new FakeBaileysSocket();
      s.lastOpts = opts;
      sockets.push(s);
      return s;
    },
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} } as unknown as AuthenticationState,
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: async () => Buffer.from("media-bytes"),
  };
});

afterEach(() => {
  rmSync(authDir, { recursive: true, force: true });
});

describe("BaileysGateway — state machine koneksi", () => {
  it("(a) 3x close bersamaan -> tepat 1 socket baru (guard anti-440)", async () => {
    const gw = makeGateway();
    await gw.connect();
    expect(sockets).toHaveLength(1);
    // Opsi socket sesuai skill: tanpa sync history, tanpa mark online.
    expect(sockets[0].lastOpts?.syncFullHistory).toBe(false);
    expect(sockets[0].lastOpts?.markOnlineOnConnect).toBe(false);
    expect(sockets[0].lastOpts?.connectTimeoutMs).toBe(60_000);
    expect(sockets[0].lastOpts?.keepAliveIntervalMs).toBe(30_000);

    const s1 = sockets[0];
    const closeUpdate = {
      connection: "close" as const,
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    };
    // Tiga event close sinkron sebelum timer reconnect (0ms) sempat jalan.
    s1.emitConnectionUpdate(closeUpdate);
    s1.emitConnectionUpdate(closeUpdate);
    s1.emitConnectionUpdate(closeUpdate);
    await tick(50);

    expect(sockets).toHaveLength(2);
    // Socket lama dibersihkan: listener dicabut + ws ditutup.
    expect(s1.listenersRemoved).toContain("*");
    expect(s1.wsClosed).toBe(true);
    await gw.disconnect();
  });

  it("open -> publish phone + nama akun", async () => {
    const gw = makeGateway();
    await gw.connect();
    sockets[0].user = { id: "6282114812842@s.whatsapp.net", name: "Reza AI" };
    sockets[0].emitConnectionUpdate({ connection: "open" });
    await tick();

    const openEvents = published.filter((p) => p.status === "open");
    expect(openEvents).toHaveLength(1);
    expect(openEvents[0].phone).toBe("6282114812842");
    expect(openEvents[0].name).toBe("Reza AI");
    expect(gw.getSelfPhone()).toBe("6282114812842");
    expect(gw.getConnectionState()).toBe("open");
    await gw.disconnect();
  });

  it("(b) loggedOut (401) -> direktori auth dibersihkan + QR baru dipublish", async () => {
    const gw = makeGateway();
    await gw.connect();
    writeFileSync(join(authDir, "creds.json"), "{}");
    writeFileSync(join(authDir, "session.dat"), "x");
    expect(readdirSync(authDir)).toHaveLength(2);

    sockets[0].emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await tick(50);

    // Isi direktori auth dihapus (bukan direktorinya).
    expect(readdirSync(authDir)).toHaveLength(0);
    // Socket baru langsung dibuat ulang.
    expect(sockets).toHaveLength(2);
    // QR baru dari socket baru dipublish ke dashboard.
    sockets[1].emitConnectionUpdate({ qr: "qr-baru-setelah-logout" });
    await tick();
    const qrEvents = published.filter((p) => p.status === "qr");
    expect(qrEvents.length).toBeGreaterThanOrEqual(1);
    expect(qrEvents[qrEvents.length - 1].qr).toBe("qr-baru-setelah-logout");
    await gw.disconnect();
  });

  it("(c) error 463 -> flag restricted set, status restricted, tanpa reconnect", async () => {
    const gw = makeGateway();
    await gw.connect();

    sockets[0].emitConnectionUpdate({
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 463 } } },
    });
    await tick(50);

    expect(await redis.get(WA_RESTRICTED_KEY)).toBe("1");
    expect(await gw.isRestricted()).toBe(true);
    expect(published[published.length - 1].status).toBe("restricted");
    expect(sockets).toHaveLength(1); // tidak auto-reconnect

    // Pengiriman ditahan selama dibatasi.
    await expect(gw.send("62812", "halo")).rejects.toThrow(/dibatasi/);

    // restart(): flag dibersihkan + konek ulang.
    await gw.restart();
    await tick(50);
    expect(await redis.get(WA_RESTRICTED_KEY)).toBeNull();
    expect(sockets).toHaveLength(2);
    await gw.disconnect();
  });

  it("logout() -> auth dibersihkan + socket baru (QR baru)", async () => {
    const gw = makeGateway();
    await gw.connect();
    writeFileSync(join(authDir, "creds.json"), "{}");

    await gw.logout();
    await tick();

    expect(readdirSync(authDir)).toHaveLength(0);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].wsClosed).toBe(true);
    await gw.disconnect();
  });

  it("disconnect() manual -> tidak reconnect", async () => {
    const gw = makeGateway();
    await gw.connect();
    await gw.disconnect();
    await tick(50);
    expect(sockets).toHaveLength(1);
    expect(gw.getConnectionState()).toBe("close");
    expect(published[published.length - 1].status).toBe("close");
  });
});

describe("BaileysGateway — pesan masuk & kirim", () => {
  it("normalisasi inbound: teks masuk, fromMe HP, & grup diteruskan (Task 5)", async () => {
    const gw = makeGateway();
    const received: InboundMessage[] = [];
    gw.onMessage((m) => {
      received.push(m);
    });
    await gw.connect();

    sockets[0].emitMessagesUpsert({
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "6281234567890@s.whatsapp.net",
            fromMe: false,
            id: "w1",
          },
          message: { conversation: "Halo, info rumah dong" },
          messageTimestamp: 1728280000,
        },
        {
          key: {
            remoteJid: "6281234567890@s.whatsapp.net",
            fromMe: true,
            id: "w2",
          },
          message: { conversation: "pesan dari HP saya" },
          messageTimestamp: 1728280001,
        },
        {
          key: { remoteJid: "120363012345@g.us", fromMe: false, id: "w3" },
          message: { conversation: "pesan grup" },
          messageTimestamp: 1728280002,
        },
        {
          key: { remoteJid: "status@broadcast", fromMe: false, id: "w4" },
          message: { conversation: "status" },
          messageTimestamp: 1728280003,
        },
      ],
    });
    await tick();

    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({
      id: "w1",
      from: "6281234567890",
      body: "Halo, info rumah dong",
      fromMe: false,
      source: "wa",
    });
    expect(received[0].timestamp).toBe(1728280000 * 1000);
    // fromMe yang bukan cermin kiriman gateway = pesan dari HP.
    expect(received[1]).toMatchObject({
      id: "w2",
      fromMe: true,
      source: "phone",
      body: "pesan dari HP saya",
    });
    // Grup & status tidak dibuang — ingest menandainya ignored.
    expect(received[2]).toMatchObject({
      id: "w3",
      chatJid: "120363012345@g.us",
    });
    expect(received[3]).toMatchObject({
      id: "w4",
      chatJid: "status@broadcast",
    });
    await gw.disconnect();
  });

  it("cermin kiriman gateway sendiri (fromMe, id terkirim) dilewati", async () => {
    const gw = makeGateway();
    const received: InboundMessage[] = [];
    gw.onMessage((m) => {
      received.push(m);
    });
    await gw.connect();

    // Kirim via gateway -> id tercatat di cache pesan terkirim.
    const { messageId } = await gw.send("6281234567890", "balasan gateway");
    sockets[0].emitMessagesUpsert({
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "6281234567890@s.whatsapp.net",
            fromMe: true,
            id: messageId,
          },
          message: { conversation: "balasan gateway" },
          messageTimestamp: 1728280000,
        },
        {
          key: {
            remoteJid: "6281234567890@s.whatsapp.net",
            fromMe: true,
            id: "w-bukan-cermin",
          },
          message: { conversation: "diketik manual di HP" },
          messageTimestamp: 1728280001,
        },
      ],
    });
    await tick();

    // Hanya pesan HP yang lolos; cermin dilewati (sudah dicatat worker).
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: "w-bukan-cermin",
      fromMe: true,
      source: "phone",
    });
    await gw.disconnect();
  });

  it("downloadMedia memakai cache pesan mentah", async () => {
    const gw = makeGateway();
    const received: InboundMessage[] = [];
    gw.onMessage((m) => {
      received.push(m);
    });
    await gw.connect();

    sockets[0].emitMessagesUpsert({
      type: "notify",
      messages: [
        {
          key: {
            remoteJid: "6281234567890@s.whatsapp.net",
            fromMe: false,
            id: "w-img",
          },
          message: { imageMessage: { caption: "foto rumah" } },
          messageTimestamp: 1728280000,
        },
      ],
    });
    await tick();

    expect(received[0].mediaType).toBe("image");
    const buf = await gw.downloadMedia(received[0]);
    expect(buf.toString()).toBe("media-bytes");
    await expect(
      gw.downloadMedia({ id: "tidak-ada", from: "x", timestamp: 1 }),
    ).rejects.toThrow(/cache/);
    await gw.disconnect();
  });

  it("send & presence memakai JID s.whatsapp.net", async () => {
    const gw = makeGateway();
    await gw.connect();
    sockets[0].user = { id: "6282114812842@s.whatsapp.net" };
    sockets[0].emitConnectionUpdate({ connection: "open" });
    await tick();

    const res = await gw.send("6281234567890", "Halo!");
    expect(res.messageId).toMatch(/^wamid-fake-/);
    expect(sockets[0].sent[0].jid).toBe("6281234567890@s.whatsapp.net");

    await gw.presence("6281234567890", "composing");
    expect(sockets[0].presence).toEqual([
      { state: "composing", jid: "6281234567890@s.whatsapp.net" },
    ]);
    await gw.disconnect();
  });
});
