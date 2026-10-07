import type Redis from "ioredis";
import RedisMock from "ioredis-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  drainWaCommandFallback,
  enqueueWaCommand,
  getLatestWaStatus,
  isRestricted,
  peekWaCommandFallback,
  publishWaStatus,
  setWaRestricted,
  WA_STATUS_CHANNEL,
} from "../src/index.js";

/**
 * Transport perintah wa-command + pub/sub status.
 * REDIS_URL=memory:// memaksa jalur list fallback (BullMQ butuh Lua asli
 * yang tidak ada di ioredis-mock) — jalur yang sama dipakai E2E.
 */
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.REDIS_URL = "memory://";
afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

let redis: Redis;
beforeEach(() => {
  redis = new RedisMock() as unknown as Redis;
});

describe("wa-command transport", () => {
  it("enqueue -> list fallback -> drain", async () => {
    const { payload, transport } = await enqueueWaCommand(redis, "logout", "e2e");
    expect(transport).toBe("list");
    expect(payload.command).toBe("logout");

    const peeked = await peekWaCommandFallback(redis);
    expect(peeked).toHaveLength(1);
    expect(peeked[0].command).toBe("logout");

    const drained = await drainWaCommandFallback(redis);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({ command: "logout", by: "e2e" });
    expect(await peekWaCommandFallback(redis)).toHaveLength(0);
  });
});

describe("wa-status pub/sub", () => {
  it("publish -> subscriber terima + latest tersimpan", async () => {
    const sub = new RedisMock() as unknown as Redis;
    const received: string[] = [];
    await sub.subscribe(WA_STATUS_CHANNEL);
    sub.on("message", (_ch, msg) => received.push(String(msg)));

    await publishWaStatus(redis, { status: "qr", qr: "qr-test-1" });
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]).qr).toBe("qr-test-1");

    const latest = await getLatestWaStatus(redis);
    expect(latest?.status).toBe("qr");
    sub.disconnect();
  });

  it("flag restricted set/get/clear", async () => {
    expect(await isRestricted(redis)).toBe(false);
    await setWaRestricted(redis, true);
    expect(await isRestricted(redis)).toBe(true);
    await setWaRestricted(redis, false);
    expect(await isRestricted(redis)).toBe(false);
  });
});
