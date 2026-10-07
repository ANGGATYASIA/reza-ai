import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import RedisMock from "ioredis-mock";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";

/**
 * Unit test antrean kirim (Task 5): limiter fixed-window, eksekusi job
 * (gateway -> Message fromMe -> event), dan roundtrip list fallback.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reza-send-test-"));
process.env.DATABASE_URL = `pglite://${dataDir}`;
process.env.REDIS_URL = "memory://";
process.env.MASTER_KEY = "c".repeat(64);

execFileSync("node", [join(here, "..", "scripts", "pglite-migrate.mjs")], {
  env: process.env,
  stdio: "pipe",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let core: any;
let prisma: PrismaClient;

function freshRedis(): Redis {
  return new RedisMock() as unknown as Redis;
}

/**
 * ioredis-mock berbagi data antar instance dalam satu proses, jadi window
 * limiter (per menit kalender) bocor antar test. Tiap test yang butuh
 * limiter bersih memakai offset menitnya sendiri (kelipatan tepat
 * 60 detik -> tidak pernah straddle window).
 */
const minute = (offsetMin: number) => Date.now() + offsetMin * 60_000;

async function makeChat(pn: string): Promise<string> {
  const contact = await prisma.contact.upsert({
    where: { pn },
    create: { pn },
    update: {},
  });
  const chat = await prisma.chat.upsert({
    where: { contactId: contact.id },
    create: { contactId: contact.id },
    update: {},
  });
  return chat.id;
}

beforeAll(async () => {
  core = await import("../src/index.js");
  prisma = core.prisma as PrismaClient;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("checkSendLimit — fixed window 20/menit", () => {
  it("20 pesan lolos, yang ke-21 ditahan", async () => {
    const redis = freshRedis();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      const r = await core.checkSendLimit(redis, now);
      expect(r.allowed).toBe(true);
    }
    const blocked = await core.checkSendLimit(redis, now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("window baru me-reset hitungan", async () => {
    const redis = freshRedis();
    const now = Date.now();
    for (let i = 0; i < 25; i++) await core.checkSendLimit(redis, now);
    const next = await core.checkSendLimit(redis, now + 61_000);
    expect(next.allowed).toBe(true);
  });
});

describe("processSendJob", () => {
  it("kirim teks: gateway dipanggil, Message fromMe tersimpan, event terbit", async () => {
    const redis = freshRedis();
    const published: string[] = [];
    const base = redis;
    const proxy = new Proxy(base, {
      get(t, p, r) {
        if (p === "publish") {
          return async (channel: string, message: string) => {
            published.push(`${channel}:${message}`);
            return (t.publish as (c: string, m: string) => Promise<number>)(
              channel,
              message,
            );
          };
        }
        return Reflect.get(t, p, r);
      },
    });
    const gateway = new core.FakeGateway();
    await gateway.connect();

    const chatId = await makeChat("628990002001");
    const { messageId } = await core.processSendJob(
      {
        chatId,
        content: { text: "Halo kak, ada yang bisa dibantu?" },
        source: "dashboard",
        requestedBy: "admin@test",
      },
      { prisma, redis: proxy as Redis, gateway, nowMs: () => minute(10) },
    );

    expect(gateway.sentTexts).toHaveLength(1);
    expect(gateway.sentTexts[0].to).toBe("628990002001");
    expect(gateway.sentTexts[0].body).toBe("Halo kak, ada yang bisa dibantu?");
    expect(gateway.sentTexts[0].id).toBe(messageId);

    const saved = await prisma.message.findUnique({
      where: { waMessageId: messageId },
    });
    expect(saved).not.toBeNull();
    expect(saved!.fromMe).toBe(true);
    expect(saved!.source).toBe("dashboard");
    expect(saved!.body).toBe("Halo kak, ada yang bisa dibantu?");

    expect(published).toHaveLength(1);
    expect(published[0]).toMatch(/^reza:inbox:/);
  });

  it("limiter penuh -> SendRateLimitedError (tidak terkirim)", async () => {
    const redis = freshRedis();
    const gateway = new core.FakeGateway();
    await gateway.connect();
    const chatId = await makeChat("628990002002");

    const now = minute(20);
    for (let i = 0; i < 20; i++) await core.checkSendLimit(redis, now);

    await expect(
      core.processSendJob(
        { chatId, content: { text: "kelebihan" }, source: "dashboard" },
        { prisma, redis, gateway, nowMs: () => now },
      ),
    ).rejects.toThrow(core.SendRateLimitedError);
    expect(gateway.sentTexts).toHaveLength(0);
  });

  it("chat tidak ada -> error jelas", async () => {
    const redis = freshRedis();
    const gateway = new core.FakeGateway();
    await gateway.connect();
    await expect(
      core.processSendJob(
        { chatId: "chat-tidak-ada", content: { text: "x" }, source: "ai" },
        { prisma, redis, gateway },
      ),
    ).rejects.toThrow(/tidak ditemukan/);
  });

  it("kontak semu (grup) -> tidak bisa dikirim", async () => {
    const redis = freshRedis();
    const gateway = new core.FakeGateway();
    await gateway.connect();
    const contact = await prisma.contact.upsert({
      where: { pn: "group:1203630999" },
      create: { pn: "group:1203630999" },
      update: {},
    });
    const chat = await prisma.chat.upsert({
      where: { contactId: contact.id },
      create: { contactId: contact.id },
      update: {},
    });
    await expect(
      core.processSendJob(
        { chatId: chat.id, content: { text: "x" }, source: "dashboard" },
        { prisma, redis, gateway },
      ),
    ).rejects.toThrow(/kontak semu/);
  });
});

describe("antrean send — fallback list (E2E)", () => {
  it("enqueueSend -> drainSendFallback roundtrip + poller mengeksekusi", async () => {
    const redis = freshRedis();
    const gateway = new core.FakeGateway();
    await gateway.connect();
    const chatId = await makeChat("628990002003");

    const { transport } = await core.enqueueSend(
      redis,
      chatId,
      { text: "via antrean" },
      "dashboard",
    );
    expect(transport).toBe("list");

    const stop = core.startSendFallbackPoller(
      redis,
      { prisma, redis, gateway, nowMs: () => minute(30) },
      50,
    );
    await new Promise((r) => setTimeout(r, 500));
    stop();

    expect(gateway.sentTexts).toHaveLength(1);
    expect(gateway.sentTexts[0].to).toBe("628990002003");
    const saved = await prisma.message.findFirst({
      where: { chatId, body: "via antrean" },
    });
    expect(saved).not.toBeNull();
    expect(saved!.source).toBe("dashboard");
  });

  it("enqueueSend tanpa isi -> error", async () => {
    const redis = freshRedis();
    await expect(
      core.enqueueSend(redis, "chat-x", {}, "dashboard"),
    ).rejects.toThrow(/text atau mediaPath/);
  });
});
