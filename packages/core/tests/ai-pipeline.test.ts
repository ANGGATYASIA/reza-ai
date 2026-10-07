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
import type { GenerateReplyResult } from "../src/ai-engine.js";

/**
 * Unit test pipeline AI (Task 8): resolusi mode, debounce self-correcting,
 * jeda manual dari HP, alur draf (semi), handoff, dan threshold confidence.
 * Database ASLI (PGlite) + Redis mock, generateReply di-stub lewat deps.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "reza-aipipe-test-"));
process.env.DATABASE_URL = `pglite://${dataDir}/test.db`;
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

let uid = 0;
const nextPn = () => `62899008${String(1000 + uid++)}`;

async function makeChatWithMessages(
  pn: string,
  bodies: Array<{ body: string; fromMe: boolean; source?: "wa" | "phone" | "dashboard" | "ai" }>,
): Promise<string> {
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
  for (const [i, m] of bodies.entries()) {
    await prisma.message.create({
      data: {
        chatId: chat.id,
        waMessageId: `t8-${pn}-${uid}-${i}-${Date.now()}`,
        fromMe: m.fromMe,
        body: m.body,
        source: m.source ?? (m.fromMe ? "phone" : "wa"),
      },
    });
  }
  return chat.id;
}

function okReply(over: Partial<GenerateReplyResult> = {}): GenerateReplyResult {
  return {
    reply: "Halo kak, harga tipe Verona mulai Rp950 juta (data uji).",
    confidence: 0.9,
    handoff: false,
    reason: null,
    sourcesUsed: [1],
    sources: [{ index: 1, itemTitle: "Daftar Harga (data uji)" }],
    ...over,
  };
}

beforeAll(async () => {
  core = await import("../src/index.js");
  prisma = core.prisma as PrismaClient;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dataDir, { recursive: true, force: true });
});

function aiDeps(
  redis: Redis,
  opts: {
    settings?: Record<string, unknown>;
    reply?: GenerateReplyResult;
    nowRef?: { now: number };
  } = {},
) {
  const gateway = new core.FakeGateway();
  const calls: Array<{ message: string; historyLength: number }> = [];
  const nowRef = opts.nowRef ?? { now: Date.now() };
  return {
    gateway,
    calls,
    deps: {
      prisma,
      redis,
      gateway,
      getGeneralSettings: async () => ({
        ...core.GENERAL_DEFAULTS,
        ...(opts.settings ?? {}),
      }),
      getChatConfig: async () => null,
      getEmbeddingConfig: async () => null,
      generateReply: async (input: { message: string; history: Array<{ role: string; text: string }> }) => {
        calls.push({ message: input.message, historyLength: input.history.length });
        return opts.reply ?? okReply();
      },
      nowMs: () => nowRef.now,
      // Tanpa jeda "mengetik" di test — kecuali diuji eksplisit.
      sleepMs: async () => {},
    },
    nowRef,
  };
}

describe("resolveMode", () => {
  it("override chat menang atas mode global", () => {
    expect(core.resolveMode({ modeOverride: "semi" }, { aiMode: "full" })).toBe("semi");
    expect(core.resolveMode({ modeOverride: "off" }, { aiMode: "full" })).toBe("off");
    expect(core.resolveMode({ modeOverride: "full" }, { aiMode: "semi" })).toBe("full");
  });

  it("tanpa override -> ikut mode global", () => {
    expect(core.resolveMode({ modeOverride: null }, { aiMode: "semi" })).toBe("semi");
    expect(core.resolveMode({}, { aiMode: "off" })).toBe("off");
  });

  it("nilai asing -> full (aman)", () => {
    expect(core.resolveMode({ modeOverride: "ngawur" }, { aiMode: "ngawur" })).toBe("full");
  });
});

describe("scheduleAiReply — kunci debounce", () => {
  it("menulis deadline now+debounceSec dan mengantrekan job", async () => {
    const redis = freshRedis();
    const before = Date.now();
    await core.scheduleAiReply(redis, "chat-x", 10);
    const raw = await redis.get(core.aiDebounceKey("chat-x"));
    const until = Number(raw);
    expect(until).toBeGreaterThanOrEqual(before + 9000);
    expect(until).toBeLessThanOrEqual(Date.now() + 11000);
    const jobs = await core.drainAiReplyFallback(redis);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].chatId).toBe("chat-x");
  });
});

describe("debounce self-correcting — 2 pesan beruntun -> 1x generateReply", () => {
  it("job awal dijadwalkan ulang; setelah window sepi reply sekali dengan riwayat gabungan", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo, info harga tipe Verona?", fromMe: false },
    ]);
    const { deps, calls, nowRef } = aiDeps(redis, {
      settings: { aiMode: "full", replyDelayMinSec: 0, replyDelayMaxSec: 0 },
    });
    await deps.gateway.connect();

    // Pesan 1 -> debounce 10 dtk.
    await core.scheduleAiReply(redis, chatId, 10);
    // Pesan 2 datang 3 dtk kemudian -> deadline bergeser.
    nowRef.now += 3000;
    await prisma.message.create({
      data: {
        chatId,
        waMessageId: `t8-bubble-${uid}`,
        fromMe: false,
        body: "DP-nya berapa ya?",
        source: "wa",
      },
    });
    await core.scheduleAiReply(redis, chatId, 10);

    // Job dari pesan 1 bangun terlalu awal -> jadwalkan ulang, bukan balas.
    const early = await core.processAiReply({ chatId }, deps);
    expect(early.status).toBe("rescheduled");
    expect(calls).toHaveLength(0);

    // Setelah window sepi (deadline pesan 2 lewat) -> SATU generateReply.
    nowRef.now += 11000;
    const done = await core.processAiReply({ chatId }, deps);
    expect(done.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("DP-nya berapa ya?");
    expect(calls[0].historyLength).toBe(2);
  });
});

describe("jeda manual dari HP", () => {
  const phoneMsg = (id: string, from: string): InboundMessage => ({
    id,
    from,
    timestamp: Date.now(),
    fromMe: true,
    source: "phone",
    body: "Saya handle langsung ya kak",
  });

  function ingestDeps(redis: Redis) {
    return {
      prisma,
      redis,
      getOwnerNumber: async () => "082114812842",
      getGeneralSettings: async () => ({
        ...core.GENERAL_DEFAULTS,
        manualPauseHours: 4,
      }),
    };
  }

  it("source=phone -> aiPaused + pausedUntil ~4 jam; ai-reply dilewati, jalan setelahnya", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo kak", fromMe: false },
    ]);

    await core.processInboundMessage(phoneMsg(`t8-hp-${uid}`, pn), ingestDeps(redis));
    const paused = await prisma.chat.findUnique({ where: { id: chatId } });
    expect(paused!.aiPaused).toBe(true);
    const pausedUntil = paused!.pausedUntil!.getTime();
    expect(pausedUntil).toBeGreaterThan(Date.now() + 3.5 * 3600_000);
    expect(pausedUntil).toBeLessThanOrEqual(Date.now() + 4.5 * 3600_000);

    const { deps, calls, nowRef } = aiDeps(redis, {
      settings: { aiMode: "full", replyDelayMinSec: 0, replyDelayMaxSec: 0 },
    });
    await deps.gateway.connect();

    // Sebelum waktunya -> dilewati.
    const skipped = await core.processAiReply({ chatId }, deps);
    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("ai-dijeda");
    expect(calls).toHaveLength(0);

    // Setelah pausedUntil lewat -> jalan lagi (auto-resume).
    // Pesan baru dari lead datang dulu (menjadwalkan debounce 10 dtk).
    const leadMsg: InboundMessage = {
      id: `t8-lead2-${uid}`,
      from: pn,
      timestamp: Date.now(),
      body: "Kak, masih ada?",
    };
    await core.processInboundMessage(leadMsg, ingestDeps(redis));
    nowRef.now = pausedUntil + 12_000;
    const resumed = await core.processAiReply({ chatId }, deps);
    expect(resumed.status).toBe("sent");
    expect(calls).toHaveLength(1);
    const after = await prisma.chat.findUnique({ where: { id: chatId } });
    expect(after!.aiPaused).toBe(false);
  });

  it("fromMe dari dashboard TIDAK menjeda AI", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo kak", fromMe: false },
    ]);
    await core.processInboundMessage(
      {
        id: `t8-dash-${uid}`,
        from: pn,
        timestamp: Date.now(),
        fromMe: true,
        source: "dashboard",
        body: "Balasan dari dasbor",
      },
      ingestDeps(redis),
    );
    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    expect(chat!.aiPaused).toBe(false);
  });
});

describe("mode full — kirim via antrean", () => {
  it("presence composing + enqueueSend source=ai -> terkirim via gateway", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo, info harga tipe Verona?", fromMe: false },
    ]);
    const { deps, gateway } = aiDeps(redis, {
      settings: { aiMode: "full", replyDelayMinSec: 0, replyDelayMaxSec: 0 },
    });
    await gateway.connect();

    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("sent");
    expect(
      gateway.presenceCalls.some(
        (p: { to: string; state: string }) => p.to === pn && p.state === "composing",
      ),
    ).toBe(true);

    // Job kirim dieksekusi -> sampai ke gateway, tersimpan source=ai.
    // (ioredis-mock berbagi data antar test: saring berdasarkan chatId.)
    const jobs = (await core.drainSendFallback(redis)).filter(
      (j: { chatId: string }) => j.chatId === chatId,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe("ai");
    await core.processSendJob(jobs[0], { prisma, redis, gateway });
    const sent = gateway.sentTexts.find((t: { to: string }) => t.to === pn);
    expect(sent).toBeTruthy();
    expect(sent.body).toContain("Rp950 juta");
    const saved = await prisma.message.findFirst({
      where: { chatId, fromMe: true },
      orderBy: { createdAt: "desc" },
    });
    expect(saved!.source).toBe("ai");
  });
});

describe("mode semi — draf + notifikasi owner", () => {
  it("Draft pending tersimpan (confidence/reason/sources) + owner dinotifikasi via FakeGateway", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo, info harga tipe Verona?", fromMe: false },
    ]);
    const { deps, gateway } = aiDeps(redis, {
      settings: { aiMode: "semi" },
      reply: okReply({ reason: "Butuh verifikasi stok", sourcesUsed: [1] }),
    });
    await gateway.connect();

    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("draft");

    const draft = await prisma.draft.findUnique({ where: { id: res.draftId } });
    expect(draft).toBeTruthy();
    expect(draft!.status).toBe("pending");
    expect(draft!.body).toContain("Rp950 juta");
    expect(draft!.confidence).toBeCloseTo(0.9);
    expect(draft!.reason).toBe("Butuh verifikasi stok");
    expect(draft!.sourcesUsed).toEqual([1]);

    // Tidak ada balasan ke lead; notifikasi ke nomor owner.
    expect(gateway.sentTexts.filter((t: { to: string }) => t.to === pn)).toHaveLength(0);
    const ownerNote = gateway.sentTexts.find(
      (t: { to: string }) => t.to === "6282114812842",
    );
    expect(ownerNote).toBeTruthy();
    expect(ownerNote.body).toContain("Draf AI");
    expect(ownerNote.body).toContain("Rp950 juta");
  });
});

describe("handoff", () => {
  it("diskon -> Handoff row + aiPaused + notifikasi owner", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Bisa diskon 10%?", fromMe: false },
    ]);
    const { deps, gateway } = aiDeps(redis, {
      settings: { aiMode: "full" },
      reply: okReply({
        reply: "",
        confidence: 0,
        handoff: true,
        reason: "Negosiasi harga/diskon — perlu persetujuan Reza langsung",
        sourcesUsed: [],
        sources: [],
      }),
    });
    await gateway.connect();

    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("handoff");

    const handoff = await prisma.handoff.findUnique({ where: { id: res.handoffId } });
    expect(handoff).toBeTruthy();
    expect(handoff!.status).toBe("open");
    expect(handoff!.reason).toContain("Negosiasi harga/diskon");
    expect(handoff!.summary).toContain("diskon 10%");

    const chat = await prisma.chat.findUnique({ where: { id: chatId } });
    expect(chat!.aiPaused).toBe(true);

    const ownerNote = gateway.sentTexts.find(
      (t: { to: string }) => t.to === "6282114812842",
    );
    expect(ownerNote).toBeTruthy();
    expect(ownerNote.body).toContain("Handoff:");
    expect(ownerNote.body).toContain("Negosiasi harga/diskon");
    expect(res.notified).toBe(true);

    // AI berhenti: pesan berikutnya tidak dibalas.
    const { deps: deps2, calls } = aiDeps(redis, {
      settings: { aiMode: "full" },
      nowRef: { now: Date.now() },
    });
    await prisma.message.create({
      data: {
        chatId,
        waMessageId: `t8-post-handoff-${uid}`,
        fromMe: false,
        body: "Halo, masih ada?",
        source: "wa",
      },
    });
    const after = await core.processAiReply({ chatId }, deps2);
    expect(after.status).toBe("skipped");
    expect(after.reason).toBe("ai-dijeda");
    expect(calls).toHaveLength(0);
  });

  it("confidence di bawah threshold -> handoff walau LLM tidak minta", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Kapan serah terimanya?", fromMe: false },
    ]);
    const { deps } = aiDeps(redis, {
      settings: { aiMode: "full", handoffConfidenceThreshold: 0.5 },
      reply: okReply({ confidence: 0.2, handoff: false }),
    });
    await deps.gateway.connect();

    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("handoff");
  });

  it("chat ignored -> dilewati tanpa generateReply", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo", fromMe: false },
    ]);
    await prisma.chat.update({ where: { id: chatId }, data: { ignored: true } });
    const { deps, calls } = aiDeps(redis, { settings: { aiMode: "full" } });
    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("chat-ignored");
    expect(calls).toHaveLength(0);
  });

  it("pesan terakhir fromMe -> dilewati (Reza sudah menjawab)", async () => {
    const redis = freshRedis();
    const pn = nextPn();
    const chatId = await makeChatWithMessages(pn, [
      { body: "Halo", fromMe: false },
      { body: "Sudah saya jawab manual", fromMe: true, source: "dashboard" },
    ]);
    const { deps, calls } = aiDeps(redis, { settings: { aiMode: "full" } });
    const res = await core.processAiReply({ chatId }, deps);
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("terakhir-dari-kita");
    expect(calls).toHaveLength(0);
  });
});
