import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { InboundMessage } from "../src/gateway.js";

/**
 * Unit test ingest (Task 5) dengan database ASLI (PGlite) + Redis mock:
 * filter ignored, mapping LID<->PN, dedup waMessageId, pesan fromMe/HP,
 * dan roundtrip antrean fallback.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reza-ingest-test-"));
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.REDIS_URL = "memory://";
process.env.MASTER_KEY = "c".repeat(64);

// Terapkan migrasi SEKALI sebelum core di-import (singleton prisma
// dibuat saat import, memakai DATABASE_URL di atas).
execFileSync("node", [join(here, "..", "scripts", "pglite-migrate.mjs")], {
  env: process.env,
  stdio: "pipe",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let core: any;
let prisma: PrismaClient;

const OWNER = "082114812842"; // default setting general.ownerWaNumber

function makeRedis() {
  const published: Array<{ channel: string; message: string }> = [];
  const base = new RedisMock() as unknown as Redis;
  const proxy = new Proxy(base, {
    get(t, p, r) {
      if (p === "publish") {
        return async (channel: string, message: string) => {
          published.push({ channel, message });
          return (t.publish as (c: string, m: string) => Promise<number>)(
            channel,
            message,
          );
        };
      }
      return Reflect.get(t, p, r);
    },
  });
  return { redis: proxy as Redis, published };
}

const msg = (over: Partial<InboundMessage> & { id: string }): InboundMessage => ({
  from: "628990001111",
  timestamp: Date.now(),
  ...over,
});

beforeAll(async () => {
  core = await import("../src/index.js");
  prisma = core.prisma as PrismaClient;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

function deps(redis: Redis) {
  return {
    prisma,
    redis,
    getOwnerNumber: async () => OWNER,
    getGeneralSettings: async () => core.GENERAL_DEFAULTS,
  };
}

describe("processInboundMessage — pesan personal", () => {
  it("menyimpan contact + chat + message, terbitkan event inbox", async () => {
    const { redis, published } = makeRedis();
    const res = await core.processInboundMessage(
      msg({ id: "t5-m1", from: "628131742034", body: "Halo, info harga" }),
      deps(redis),
    );

    expect(res.deduped).toBe(false);
    expect(res.ignored).toBe(false);
    expect(res.isNewChat).toBe(true);
    expect(res.fromMe).toBe(false);

    const contact = await prisma.contact.findUnique({
      where: { pn: "628131742034" },
    });
    expect(contact).not.toBeNull();
    expect(contact!.tag).toBe("Lead");
    const chat = await prisma.chat.findUnique({
      where: { contactId: contact!.id },
      include: { messages: true },
    });
    expect(chat!.messages).toHaveLength(1);
    expect(chat!.messages[0].fromMe).toBe(false);
    expect(chat!.messages[0].source).toBe("wa");
    expect(chat!.messages[0].waMessageId).toBe("t5-m1");

    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe("reza:inbox");
    const ev = JSON.parse(published[0].message);
    expect(ev.type).toBe("new-message");
    expect(ev.chatId).toBe(res.chatId);
  });

  it("08xx dan 628xx = satu kontak (tidak duplikat)", async () => {
    const { redis } = makeRedis();
    await core.processInboundMessage(
      msg({ id: "t5-m2", from: "08131742034", body: "format 08" }),
      deps(redis),
    );
    const count = await prisma.contact.count({
      where: { pn: "628131742034" },
    });
    expect(count).toBe(1);
  });

  it("dedup: waMessageId sama tidak disimpan dua kali", async () => {
    const { redis, published } = makeRedis();
    const first = await core.processInboundMessage(
      msg({ id: "t5-dup", from: "628990001112", body: "satu" }),
      deps(redis),
    );
    const second = await core.processInboundMessage(
      msg({ id: "t5-dup", from: "628990001112", body: "satu lagi" }),
      deps(redis),
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    const n = await prisma.message.count({
      where: { waMessageId: "t5-dup" },
    });
    expect(n).toBe(1);
    // Event hanya diterbitkan untuk pesan baru.
    expect(published).toHaveLength(1);
  });

  it("pesan fromMe dari HP tersimpan dengan source=phone", async () => {
    const { redis } = makeRedis();
    const res = await core.processInboundMessage(
      msg({
        id: "t5-hp1",
        from: "628990001113",
        fromMe: true,
        source: "phone",
        body: "Saya balas dari HP",
      }),
      deps(redis),
    );
    expect(res.fromMe).toBe(true);
    expect(res.ignored).toBe(false);
    const saved = await prisma.message.findUnique({
      where: { waMessageId: "t5-hp1" },
    });
    expect(saved!.fromMe).toBe(true);
    expect(saved!.source).toBe("phone");
  });

  it("tanpa identitas (pn & lid kosong) -> error jelas", async () => {
    const { redis } = makeRedis();
    await expect(
      core.processInboundMessage(msg({ id: "t5-non", from: "" }), deps(redis)),
    ).rejects.toThrow(/tanpa identitas/);
  });
});

describe("processInboundMessage — filter ignored", () => {
  it("grup (@g.us) -> chat ignored, tetap tersimpan", async () => {
    const { redis } = makeRedis();
    const res = await core.processInboundMessage(
      msg({
        id: "t5-g1",
        from: "628990001114",
        chatJid: "120363012345@g.us",
        body: "pesan grup",
      }),
      deps(redis),
    );
    expect(res.ignored).toBe(true);
    const contact = await prisma.contact.findUnique({
      where: { pn: "group:120363012345" },
    });
    expect(contact).not.toBeNull();
    const chat = await prisma.chat.findUnique({
      where: { contactId: contact!.id },
    });
    expect(chat!.ignored).toBe(true);
  });

  it("status@broadcast -> chat ignored", async () => {
    const { redis } = makeRedis();
    const res = await core.processInboundMessage(
      msg({ id: "t5-b1", from: "", chatJid: "status@broadcast", body: "status" }),
      deps(redis),
    );
    expect(res.ignored).toBe(true);
    const contact = await prisma.contact.findUnique({
      where: { pn: "broadcast" },
    });
    expect(contact).not.toBeNull();
  });

  it("nomor owner (08xx vs 628xx) -> chat ignored", async () => {
    const { redis } = makeRedis();
    const res = await core.processInboundMessage(
      msg({ id: "t5-own1", from: "6282114812842", body: "chat sendiri" }),
      deps(redis),
    );
    expect(res.ignored).toBe(true);
  });

  it("kontak tag Internal -> chat ignored", async () => {
    const { redis } = makeRedis();
    await prisma.contact.upsert({
      where: { pn: "628990001115" },
      create: { pn: "628990001115", tag: "Internal" },
      update: { tag: "Internal" },
    });
    const res = await core.processInboundMessage(
      msg({ id: "t5-int1", from: "628990001115", body: "orang dalam" }),
      deps(redis),
    );
    expect(res.ignored).toBe(true);
  });
});

describe("processInboundMessage — mapping LID<->PN", () => {
  it("pesan via @lid lalu via pn -> satu kontak, pn terisi", async () => {
    const { redis } = makeRedis();
    await core.processInboundMessage(
      msg({ id: "t5-lid1", from: "", lid: "LID-TEST-1", body: "via lid" }),
      deps(redis),
    );
    let c = await prisma.contact.findUnique({ where: { lid: "LID-TEST-1" } });
    expect(c).not.toBeNull();
    expect(c!.pn).toBe("lid:LID-TEST-1");

    await core.processInboundMessage(
      msg({
        id: "t5-lid2",
        from: "628555000111",
        lid: "LID-TEST-1",
        body: "via pn",
      }),
      deps(redis),
    );
    c = await prisma.contact.findUnique({ where: { lid: "LID-TEST-1" } });
    expect(c!.pn).toBe("628555000111");

    // Pesan ketiga hanya via pn -> tetap satu kontak.
    await core.processInboundMessage(
      msg({ id: "t5-lid3", from: "628555000111", body: "lagi" }),
      deps(redis),
    );
    const n = await prisma.contact.count({
      where: { OR: [{ pn: "628555000111" }, { lid: "LID-TEST-1" }] },
    });
    expect(n).toBe(1);
  });
});

describe("antrean ingest — fallback list (E2E)", () => {
  it("enqueueIngest -> drainIngestFallback roundtrip", async () => {
    const { redis } = makeRedis();
    const { transport } = await core.enqueueIngest(
      redis,
      msg({ id: "t5-q1", from: "628990001116", body: "via antrean" }),
    );
    // REDIS_URL=memory:// di test ini -> transport list.
    expect(transport).toBe("list");
    const items = await core.drainIngestFallback(redis);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("t5-q1");

    // Poller memprosesnya sampai ke DB.
    const stop = core.startIngestFallbackPoller(redis, deps(redis), 50);
    await core.enqueueIngest(
      redis,
      msg({ id: "t5-q2", from: "628990001116", body: "via poller" }),
    );
    await new Promise((r) => setTimeout(r, 400));
    stop();
    const saved = await prisma.message.findUnique({
      where: { waMessageId: "t5-q2" },
    });
    expect(saved).not.toBeNull();
    expect(saved!.body).toBe("via poller");
  });
});
