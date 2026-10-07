import { createServer, type Server } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { generateSync } from "otplib";

/**
 * E2E Task 8 — wiring AI ke WhatsApp: mode, draf, handoff, jeda.
 *
 * Arsitektur yang diuji (backend 100% kode produksi):
 *   test -> POST /api/test/inbox/simulate -> FakeGateway harness
 *        -> onMessage -> enqueueIngest (core) -> poller 250ms
 *        -> processInboundMessage REAL (ingest.ts):
 *             pesan biasa -> scheduleAiReply (debounce per chat)
 *             source=phone -> Chat.aiPaused + pausedUntil
 *        -> poller 250ms -> processAiReply REAL (ai-pipeline.ts):
 *             cek paused/ignored/debounce -> generateReply REAL
 *             (hybridSearch REAL ke PGlite + POST chat mock via fetch produksi)
 *             -> handoff / mode full (presence + jeda + enqueueSend)
 *               / mode semi (Draft + notifikasi owner)
 *        -> poller 250ms -> processSendJob REAL -> FakeGateway.send
 *        -> publish reza:inbox -> SSE -> UI /inbox (draf, banner, badge)
 *
 * JUJUR: yang disimulasikan HANYA
 *   (1) gateway WhatsApp (FakeGateway, bukan Baileys),
 *   (2) provider embedding (server HTTP mock lokal, vektor hash deterministik),
 *   (3) provider chat (server HTTP mock lokal, JSON canned),
 *   (4) isi pesan masuknya (seolah pelanggan/HP mengirim via WhatsApp),
 * dan data knowledge-nya (seed "DATA UJI (fiktif)" — harga Rp950 juta
 * BUKAN harga sungguhan, lihat docs/demo-task-8.md).
 * Seluruh pipeline — debounce, resolusi mode, draf, handoff, notifikasi
 * owner, jeda manual — adalah kode produksi yang sama dipakai apps/worker.
 *
 * Prasyarat: database E2E FRESH (pnpm e2e:reset-db — file ini membuat
 * adminnya sendiri lewat wizard /setup), lalu server jalan di
 * http://127.0.0.1:3100 dengan env E2E (lihat docs/demo-task-6.md),
 * termasuk E2E_TEST_API=1.
 * Jalankan sendiri:  npx playwright test ai-agent.spec.ts
 */

const ADMIN_EMAIL = "e2e-ai-agent@reza-ai.test";
const ADMIN_PASSWORD = "Katasandi!E2EAgent8";
const E2E_EMBED_KEY = "e2e-test-key";
const E2E_CHAT_KEY = "e2e-chat-key";
const EMBED_DIM = 1536;

// Nomor lead fiktif per skenario (format 628xx, dinormalisasi ingest).
const PN_FULL = "628990008001";
const PN_SEMI = "628990008002";
const PN_HANDOFF = "628990008003";
const PN_PAUSE = "628990008004";
// Nomor owner default (pengaturan general.ownerWaNumber).
const PN_OWNER = "6282114812842";

// Balasan canned dari mock chat — data uji, bukan harga sungguhan.
const CANNED_REPLY =
  "Harga tipe Verona mulai Rp950 juta (data uji untuk playground). Mau aku infoin detail lainnya?";

const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function watchConsole(page: Page) {
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
}

function totpNow(secret: string): string {
  return generateSync({ secret });
}

// FNV-1a per kata -> vektor deterministik (mock embedding, pola Task 6/7).
function hashVec(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[(h >>> 0) % dim] += 1;
  }
  return vec;
}

let embedServer: Server;
let chatServer: Server;
let embedPort = 0;
let chatPort = 0;

function startMockEmbedding(): Promise<number> {
  return new Promise((resolve) => {
    embedServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/embeddings") {
        if (req.headers.authorization !== `Bearer ${E2E_EMBED_KEY}`) {
          json(401, { error: { message: "Incorrect API key provided" } });
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw) as { input: string[] };
          json(200, {
            data: body.input.map((t, i) => ({
              embedding: hashVec(t, EMBED_DIM),
              index: i,
            })),
          });
        });
      } else {
        json(404, { error: "not found" });
      }
    });
    embedServer.listen(0, "127.0.0.1", () => {
      embedPort = (embedServer.address() as { port: number }).port;
      resolve(embedPort);
    });
  });
}

/**
 * Mock chat OpenAI-compatible. Menjawab berdasar isi pesan user:
 * - mengandung "diskon"/"nego" -> JSON handoff (jalur defensif; di
 *   praktiknya gerbang intent di generateReply sudah handoff duluan)
 * - selain itu -> JSON canned confidence 0.9, sourcesUsed [1]
 */
function startMockChat(): Promise<number> {
  return new Promise((resolve) => {
    chatServer = createServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && req.url === "/chat/completions") {
        if (req.headers.authorization !== `Bearer ${E2E_CHAT_KEY}`) {
          json(401, { error: { message: "Incorrect API key provided" } });
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const body = JSON.parse(raw) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const users = (body.messages ?? []).filter((m) => m.role === "user");
          const lastUser = users[users.length - 1]?.content ?? "";
          const handoff = /diskon|nego/i.test(lastUser);
          const reply = handoff
            ? {
                reply: "",
                confidence: 0,
                handoff: true,
                reason:
                  "Negosiasi harga/diskon — perlu persetujuan Reza langsung",
                sourcesUsed: [],
              }
            : {
                reply: CANNED_REPLY,
                confidence: 0.9,
                handoff: false,
                reason: null,
                sourcesUsed: [1],
              };
          json(200, { choices: [{ message: { content: JSON.stringify(reply) } }] });
        });
      } else {
        json(404, { error: "not found" });
      }
    });
    chatServer.listen(0, "127.0.0.1", () => {
      chatPort = (chatServer.address() as { port: number }).port;
      resolve(chatPort);
    });
  });
}

/** Panggil API (test-only maupun produksi) lewat browser. */
async function api(
  page: Page,
  path: string,
  body?: unknown,
  method?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, body, method }: { path: string; body?: unknown; method?: string }) => {
      const res = await fetch(path, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, data };
    },
    { path, body, method },
  );
}

async function simulate(page: Page, msg: Record<string, unknown>) {
  const { status, data } = await api(page, "/api/test/inbox/simulate", {
    timestamp: Date.now(),
    ...msg,
  });
  expect(status, `simulate gagal: ${JSON.stringify(data)}`).toBe(200);
}

async function findChatId(page: Page, pn: string): Promise<string> {
  let chatId = "";
  await expect(async () => {
    const { status, data } = await api(page, "/api/inbox/chats?includeIgnored=1");
    expect(status).toBe(200);
    const chats = data.chats as Array<{ id: string; contact: { pn: string } }>;
    const chat = chats.find((c) => c.contact.pn === pn);
    expect(chat, `chat untuk ${pn} belum ada`).toBeTruthy();
    chatId = chat!.id;
  }).toPass({ timeout: 15000 });
  return chatId;
}

async function sentTexts(page: Page): Promise<Array<{ to: string; body: string }>> {
  const { status, data } = await api(page, "/api/test/inbox/sent");
  expect(status).toBe(200);
  return data.texts as Array<{ to: string; body: string }>;
}

async function waitSentTo(
  page: Page,
  to: string,
  match: RegExp,
  minCount = 1,
): Promise<Array<{ to: string; body: string }>> {
  let found: Array<{ to: string; body: string }> = [];
  await expect(async () => {
    const texts = await sentTexts(page);
    found = texts.filter((t) => t.to === to && match.test(t.body));
    expect(found.length, `belum ada kiriman ke ${to} yang cocok`).toBeGreaterThanOrEqual(
      minCount,
    );
  }).toPass({ timeout: 30000 });
  return found;
}

async function pendingDrafts(
  page: Page,
  chatId: string,
): Promise<Array<{ id: string; body: string; confidence: number | null }>> {
  const { status, data } = await api(page, `/api/inbox/drafts?chatId=${chatId}`);
  expect(status).toBe(200);
  return data.drafts as Array<{ id: string; body: string; confidence: number | null }>;
}

test.describe.serial("Task 8 — agen AI end-to-end (mode, draf, handoff, jeda)", () => {
  let totpSecret = "";

  test.beforeAll(async () => {
    await startMockEmbedding();
    await startMockChat();
  });

  test.afterAll(async () => {
    embedServer.close();
    chatServer.close();
  });

  async function login(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Masuk" }).click();
    await page.getByLabel("Kode verifikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Verifikasi dan masuk" }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15000 });
  }

  test("1. /setup: buat admin untuk file ini", async ({ page }) => {
    watchConsole(page);
    await page.goto("/setup");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Kata sandi").fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Lanjut" }).click();

    await expect(page.getByAltText("Kode QR TOTP")).toBeVisible({ timeout: 15000 });
    totpSecret = await page.locator("#secret").inputValue();

    await page.getByLabel("Kode 6 digit dari aplikasi").fill(totpNow(totpSecret));
    await page.getByRole("button", { name: "Aktifkan dan selesai" }).click();
    await expect(page.getByText("Penyiapan selesai")).toBeVisible({ timeout: 15000 });
  });

  test("2. mock provider + seed knowledge + harness + pengaturan AI", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);

    const e = await api(page, "/api/test/knowledge/mock-embedding", {
      baseUrl: `http://127.0.0.1:${embedPort}`,
      apiKey: E2E_EMBED_KEY,
      model: "mock-embed-1536",
    });
    expect(e.status, `mock-embedding gagal: ${JSON.stringify(e.data)}`).toBe(200);

    const c = await api(page, "/api/test/playground/mock-chat", {
      baseUrl: `http://127.0.0.1:${chatPort}`,
      apiKey: E2E_CHAT_KEY,
      model: "mock-chat",
    });
    expect(c.status, `mock-chat gagal: ${JSON.stringify(c.data)}`).toBe(200);

    const s = await api(page, "/api/test/playground/seed", {});
    expect(s.status, `seed gagal: ${JSON.stringify(s.data)}`).toBe(200);

    // Harness inbox: consumer ingest + send + ai-reply (kode produksi).
    const h = await api(page, "/api/test/inbox/harness", {});
    expect(h.status, `harness gagal: ${JSON.stringify(h.data)}`).toBe(200);
    expect(h.data.running).toBe(true);

    // Pengaturan AI untuk E2E: debounce & jeda 1–2 dtk (nilai jujur,
    // bukan percepat waktu — pipeline-nya yang asli).
    const st = await api(
      page,
      "/api/settings",
      {
        general: {
          aiMode: "full",
          debounceSec: 1,
          replyDelayMinSec: 1,
          replyDelayMaxSec: 2,
          handoffConfidenceThreshold: 0.5,
          manualPauseHours: 4,
        },
      },
      "PUT",
    );
    expect(st.status, `settings gagal: ${JSON.stringify(st.data)}`).toBe(200);

    const g = await api(page, "/api/settings");
    const general = g.data.general as Record<string, unknown>;
    expect(general.debounceSec).toBe(1);
    expect(general.replyDelayMaxSec).toBe(2);
  });

  test("3a. MODE FULL: override full -> pesan -> balasan AI terkirim", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);

    await simulate(page, { id: "t8-full-1", from: PN_FULL, body: "Halo" });
    const chatId = await findChatId(page, PN_FULL);

    // Override eksplisit (bukti endpoint + resolveMode override-menang).
    const m = await api(page, `/api/inbox/chats/${chatId}`, { modeOverride: "full" }, "PATCH");
    expect(m.status, `set mode gagal: ${JSON.stringify(m.data)}`).toBe(200);

    await simulate(page, {
      id: "t8-full-2",
      from: PN_FULL,
      body: "Halo, info harga tipe Verona?",
    });

    // BUKTI: FakeGateway mencatat balasan AI (teks = dari mock chat).
    await waitSentTo(page, PN_FULL, /Rp950 juta/);

    // UI inbox menampilkan pesan AI.
    await page.goto("/inbox");
    await page.getByTestId("chat-list").getByText("+62 899-0008-001").click();
    await expect(
      page.getByTestId("thread").getByText(CANNED_REPLY),
    ).toBeVisible({ timeout: 15000 });
    // Pemilih mode menunjukkan override Full.
    await expect(page.getByTestId("mode-override")).toHaveValue("full", {
      timeout: 15000,
    });
  });

  test("3b. MODE SEMI: pesan -> draf pending + notifikasi owner -> Setujui -> terkirim", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);

    await simulate(page, { id: "t8-semi-1", from: PN_SEMI, body: "Halo" });
    const chatId = await findChatId(page, PN_SEMI);
    // Tunggu balasan full-mode untuk "Halo" selesai DULU (mode global full) —
    // baru ubah override ke semi, supaya tidak ada balapan dengan consumer.
    await waitSentTo(page, PN_SEMI, /Rp950 juta/, 1);
    const m = await api(page, `/api/inbox/chats/${chatId}`, { modeOverride: "semi" }, "PATCH");
    expect(m.status).toBe(200);
    const before = (await sentTexts(page)).filter((t) => t.to === PN_SEMI).length;

    await simulate(page, {
      id: "t8-semi-2",
      from: PN_SEMI,
      body: "Ada promo apa bulan ini?",
    });

    // BUKTI: Draft pending muncul (bukan balasan langsung).
    let drafts: Array<{ id: string; body: string; confidence: number | null }> = [];
    await expect(async () => {
      drafts = await pendingDrafts(page, chatId);
      expect(drafts.length, "draf pending belum muncul").toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });
    expect(drafts[0].body).toBe(CANNED_REPLY);
    expect(drafts[0].confidence).toBeCloseTo(0.9);

    // BUKTI: tidak ada kiriman baru ke lead; notifikasi sampai ke owner.
    await page.waitForTimeout(4000);
    const mid = (await sentTexts(page)).filter((t) => t.to === PN_SEMI).length;
    expect(mid, "mode semi tidak boleh membalas langsung").toBe(before);
    await waitSentTo(page, PN_OWNER, /Draf AI/);

    // UI: kartu draf tampil dengan teks + keyakinan.
    await page.goto("/inbox");
    await page.getByTestId("chat-list").getByText("+62 899-0008-002").click();
    const card = page.getByTestId("draft-card");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByTestId("draft-body")).toHaveText(CANNED_REPLY);
    await expect(card.getByText(/Keyakinan 90%/)).toBeVisible();

    // Klik Setujui -> terkirim ke lead via antrean (source ai).
    await card.getByTestId("draft-approve").click();
    await waitSentTo(page, PN_SEMI, /Rp950 juta/, before + 1);
    // Draf hilang dari daftar pending.
    await expect(async () => {
      const rest = await pendingDrafts(page, chatId);
      expect(rest.length).toBe(0);
    }).toPass({ timeout: 15000 });
    await expect(card).not.toBeVisible({ timeout: 15000 });
  });

  test("3c. HANDOFF: 'bisa diskon 10%?' -> banner + AI jeda + notifikasi -> Lanjutkan AI", async ({
    page,
  }) => {
    watchConsole(page);
    await login(page);

    await simulate(page, {
      id: "t8-ho-1",
      from: PN_HANDOFF,
      body: "bisa diskon 10%?",
    });
    const chatId = await findChatId(page, PN_HANDOFF);

    // BUKTI DB: baris Handoff + aiPaused.
    await expect(async () => {
      const { status, data } = await api(page, `/api/inbox/chats/${chatId}`);
      expect(status).toBe(200);
      const chat = data.chat as { aiPaused: boolean; openHandoff: { reason: string } | null };
      expect(chat.aiPaused, "AI belum dijeda").toBe(true);
      expect(chat.openHandoff, "handoff belum tercatat").toBeTruthy();
      expect(chat.openHandoff!.reason).toContain("Negosiasi harga/diskon");
    }).toPass({ timeout: 30000 });

    // BUKTI: notifikasi owner berisi alasan handoff.
    await waitSentTo(page, PN_OWNER, /Handoff:.*Negosiasi harga\/diskon/s);

    // UI: banner handoff + badge "AI jeda".
    await page.goto("/inbox");
    await page.getByTestId("chat-list").getByText("+62 899-0008-003").click();
    const banner = page.getByTestId("handoff-banner");
    await expect(banner).toBeVisible({ timeout: 15000 });
    await expect(banner).toHaveText(/Chat dijeda/);
    await expect(banner).toHaveText(/Negosiasi harga\/diskon/);
    await expect(
      page.getByTestId("thread-header").getByText("AI jeda"),
    ).toBeVisible();

    // Klik "Lanjutkan AI" -> jeda lepas.
    await banner.getByRole("button", { name: "Lanjutkan AI" }).click();
    await expect(banner).not.toBeVisible({ timeout: 15000 });
    await expect(async () => {
      const { data } = await api(page, `/api/inbox/chats/${chatId}`);
      const chat = data.chat as { aiPaused: boolean };
      expect(chat.aiPaused).toBe(false);
    }).toPass({ timeout: 15000 });

    // BUKTI AI benar-benar lanjut: pesan baru dibalas lagi.
    await simulate(page, {
      id: "t8-ho-2",
      from: PN_HANDOFF,
      body: "Oke, kalau tipe Verona harganya berapa?",
    });
    await waitSentTo(page, PN_HANDOFF, /Rp950 juta/);
  });

  test("3d. JEDA MANUAL: balasan dari HP -> AI diam", async ({ page }) => {
    watchConsole(page);
    await login(page);

    // Reza membalas manual dari HP.
    await simulate(page, {
      id: "t8-pm-1",
      from: PN_PAUSE,
      fromMe: true,
      source: "phone",
      body: "Halo kak, saya Reza — saya handle langsung ya",
    });
    const chatId = await findChatId(page, PN_PAUSE);

    // BUKTI: chat ter-pause (pausedUntil ~4 jam ke depan).
    await expect(async () => {
      const { data } = await api(page, `/api/inbox/chats/${chatId}`);
      const chat = data.chat as { aiPaused: boolean; pausedUntil: string | null };
      expect(chat.aiPaused).toBe(true);
      expect(chat.pausedUntil).toBeTruthy();
    }).toPass({ timeout: 15000 });

    // Pesan baru dari lead: AI TIDAK boleh membalas.
    await simulate(page, {
      id: "t8-pm-2",
      from: PN_PAUSE,
      body: "Halo kak, masih online?",
    });
    await page.waitForTimeout(6000);
    const texts = await sentTexts(page);
    expect(
      texts.filter((t) => t.to === PN_PAUSE),
      "AI membalas padahal sedang jeda manual",
    ).toHaveLength(0);
    const drafts = await pendingDrafts(page, chatId);
    expect(drafts, "AI membuat draf padahal sedang jeda manual").toHaveLength(0);

    // UI: badge "AI jeda" tampil.
    await page.goto("/inbox");
    await page.getByTestId("chat-list").getByText("+62 899-0008-004").click();
    await expect(
      page.getByTestId("thread-header").getByText("AI jeda"),
    ).toBeVisible({ timeout: 15000 });
  });

  test("4. API terproteksi tanpa sesi -> 401", async ({ request }) => {
    expect((await request.get("/api/inbox/drafts")).status()).toBe(401);
    expect(
      (await request.post("/api/inbox/drafts/x/approve", { data: {} })).status(),
    ).toBe(401);
    expect(
      (await request.post("/api/inbox/drafts/x/reject", { data: {} })).status(),
    ).toBe(401);
    expect(
      (await request.post("/api/inbox/chats/x/resume", { data: {} })).status(),
    ).toBe(401);
    expect(
      (await request.patch("/api/inbox/chats/x", { data: {} })).status(),
    ).toBe(401);
  });

  test("5. zero console error & pageerror", async () => {
    expect(pageErrors, `pageerror: ${pageErrors.join("\n")}`).toEqual([]);
    expect(consoleErrors, `console.error: ${consoleErrors.join("\n")}`).toEqual([]);
  });
});
