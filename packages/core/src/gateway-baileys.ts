import fs from "node:fs";
import path from "node:path";
import type Redis from "ioredis";
import type {
  AuthenticationState,
  WAMessage,
  makeWASocket as makeWASocketFn,
} from "@whiskeysockets/baileys";
import type {
  InboundMessage,
  PresenceState,
  SendResult,
  WhatsAppGateway,
} from "./gateway.js";
import { normalizeJid, pnToJid } from "./wa-jid.js";
import {
  isRestricted as readRestrictedFlag,
  publishWaStatus,
  setWaRestricted,
  type WaConnectionStatus,
  type WaStatusPayload,
} from "./wa-status.js";

// ============================================================
// BaileysGateway — implementasi WhatsAppGateway di atas
// @whiskeysockets/baileys (v7, ESM — di-import dinamis agar core
// tetap bisa di-build sebagai CommonJS).
//
// Aturan koneksi (dari skill whatsapp-baileys + riset plan):
// - SATU socket per proses; guard isReconnecting anti error 440.
// - Socket lama selalu ditutup (removeAllListeners + ws.close())
//   sebelum socket baru dibuat.
// - Backoff eksponensial 2s -> 4s -> ... -> maks 60s.
// - Tidak reconnect saat disconnect manual (logout/disconnect).
// - loggedOut (401): direktori auth dibersihkan, konek ulang -> QR baru.
// - 463 (akun dibatasi): flag Redis reza:wa:restricted=1, status
//   "restricted", TANPA auto-reconnect (tunggu perintah restart).
// ============================================================

/** Opsi makeWASocket (tipe diambil dari baileys asli). */
export type BaileysSocketOptions = Parameters<typeof makeWASocketFn>[0];

/** Event connection.update (bentuk minimal yang dipakai gateway). */
export interface ConnectionUpdateLike {
  connection?: "open" | "connecting" | "close";
  qr?: string;
  lastDisconnect?: {
    error?: { output?: { statusCode?: number }; statusCode?: number };
  };
}

/** Pesan mentah minimal untuk normalisasi inbound. */
export interface RawMessageLike {
  key: {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
    participant?: string;
  };
  /** Nama tampilan pengirim dari WhatsApp (pushName). */
  pushName?: string;
  message?: Record<string, unknown> | null;
  messageTimestamp?: unknown;
}

/** Event messages.upsert (bentuk minimal). */
export interface MessagesUpsertLike {
  type: string;
  messages?: RawMessageLike[];
}

/** Socket minimal yang dibutuhkan gateway (WASocket asli memenuhinya). */
export interface MinimalSocket {
  ev: {
    on(event: "connection.update", cb: (u: ConnectionUpdateLike) => void): void;
    on(event: "creds.update", cb: () => void): void;
    on(event: "messages.upsert", cb: (u: MessagesUpsertLike) => void): void;
    removeAllListeners(event?: string): void;
  };
  ws: { close(): void };
  user?: { id: string; name?: string };
  signalRepository?: {
    lidMapping?: {
      getPNForLID(lid: string): Promise<string | null>;
    };
  };
  sendMessage(
    jid: string,
    content: unknown,
  ): Promise<{ key: { id?: string | null } } | undefined>;
  sendPresenceUpdate(state: string, jid: string): Promise<void>;
}

/** Dependensi Baileys — di-inject untuk unit test, default import dinamis. */
export interface BaileysDeps {
  makeWASocket: (opts: BaileysSocketOptions) => MinimalSocket;
  useMultiFileAuthState: (
    dir: string,
  ) => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  fetchLatestBaileysVersion: () => Promise<{ version: unknown }>;
  DisconnectReason: { loggedOut: number };
  downloadMediaMessage: (
    msg: WAMessage,
    type: "buffer",
    opts: Record<string, unknown>,
  ) => Promise<Buffer>;
}

let cachedDeps: Promise<BaileysDeps> | null = null;

/** Import dinamis @whiskeysockets/baileys (ESM). Di-cache per proses. */
export function getRealBaileysDeps(): Promise<BaileysDeps> {
  if (!cachedDeps) {
    cachedDeps = import("@whiskeysockets/baileys").then((B) => {
      const sockOpts = (o: BaileysSocketOptions) =>
        B.makeWASocket(
          o as unknown as Parameters<typeof B.makeWASocket>[0],
        ) as unknown as MinimalSocket;
      return {
        makeWASocket: sockOpts,
        useMultiFileAuthState: B.useMultiFileAuthState,
        fetchLatestBaileysVersion: B.fetchLatestBaileysVersion,
        DisconnectReason: B.DisconnectReason,
        downloadMediaMessage: B.downloadMediaMessage as (
          msg: WAMessage,
          type: "buffer",
          opts: Record<string, unknown>,
        ) => Promise<Buffer>,
      };
    });
  }
  return cachedDeps;
}

export interface BaileysGatewayOptions {
  redis: Redis;
  /** Default: process.env.WA_AUTH_DIR || "/data/wa-auth". */
  authDir?: string;
  /** Override publish (unit test). Default: publishWaStatus ke Redis. */
  publish?: (payload: WaStatusPayload) => void | Promise<void>;
  /** Inject dependensi (unit test). Default: getRealBaileysDeps(). */
  deps?: BaileysDeps | Promise<BaileysDeps>;
  /** Hitung jeda reconnect dari nomor percobaan. Default: 2s * 2^n, maks 60s. */
  reconnectDelayMs?: (attempt: number) => number;
  /** Bila true, log debug koneksi ke console. */
  verbose?: boolean;
}

const DEFAULT_AUTH_DIR = "/data/wa-auth";
const MAX_RAW_CACHE = 500;
/**
 * Umur cache ID pesan terkirim (ms). Pesan fromMe yang id-nya ada di cache
 * ini dianggap cermin kiriman gateway sendiri (Baileys menggemakan pesan
 * yang kita kirim) — dilewati agar tidak tercatat dobel. Pesan fromMe
 * yang TIDAK ada di cache = diketik/dikirim dari HP -> dicatat
 * (source "phone", Task 5).
 */
const SENT_CACHE_TTL_MS = 15 * 60 * 1000;

/** Bentuk logger yang dipakai makeWASocket (disederhanakan dari ILogger baileys). */
export interface SocketLogger {
  level: string;
  trace(...a: unknown[]): void;
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
  fatal(...a: unknown[]): void;
  child(...a: unknown[]): SocketLogger;
}

/** Logger minimal untuk socket baileys (error ke console, sisanya diam). */
function makeSocketLogger(verbose: boolean): SocketLogger {
  const debug = verbose ? console.debug.bind(console) : () => {};
  const info = verbose ? console.info.bind(console) : () => {};
  const mk = (): SocketLogger => ({
    level: verbose ? "debug" : "silent",
    trace: debug,
    debug,
    info,
    warn: (...a: unknown[]) => console.warn("[wa]", ...a),
    error: (...a: unknown[]) => console.error("[wa]", ...a),
    fatal: (...a: unknown[]) => console.error("[wa]", ...a),
    child: () => mk(),
  });
  return mk();
}

export class BaileysGateway implements WhatsAppGateway {
  private readonly redis: Redis;
  private readonly authDir: string;
  private readonly publishFn: (p: WaStatusPayload) => void | Promise<void>;
  private readonly depsInput?: BaileysDeps | Promise<BaileysDeps>;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly verbose: boolean;

  private depsCache: BaileysDeps | null = null;
  private sock: MinimalSocket | null = null;
  private isReconnecting = false;
  private manualClose = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private lastStatus: WaConnectionStatus = "close";
  private selfPhone: string | undefined;
  private selfLid: string | undefined;

  private readonly messageHandlers: Array<
    (msg: InboundMessage) => void | Promise<void>
  > = [];
  private readonly connectionHandlers: Array<
    (status: "open" | "close" | "connecting") => void
  > = [];
  private readonly statusHandlers: Array<(p: WaStatusPayload) => void> = [];
  /** Cache pesan mentah (id -> WAMessage) untuk downloadMedia. */
  private readonly rawCache = new Map<string, WAMessage>();
  /** ID pesan yang dikirim gateway ini (id -> timestamp ms). */
  private readonly sentIds = new Map<string, number>();

  /** Catat ID pesan hasil kirim gateway (untuk deteksi cermin fromMe). */
  private noteSent(messageId: string): void {
    this.sentIds.set(messageId, Date.now());
    this.pruneSentIds();
  }

  private pruneSentIds(now = Date.now()): void {
    for (const [id, ts] of this.sentIds) {
      if (now - ts > SENT_CACHE_TTL_MS) this.sentIds.delete(id);
    }
  }

  /**
   * True bila id ini baru saja dikirim gateway ini (dalam
   * SENT_CACHE_TTL_MS terakhir). Dipakai untuk melewati cermin fromMe
   * dari Baileys — pesan itu sudah dicatat worker saat mengirim.
   */
  isOwnRecentSend(messageId: string): boolean {
    this.pruneSentIds();
    return this.sentIds.has(messageId);
  }

  constructor(opts: BaileysGatewayOptions) {
    this.redis = opts.redis;
    this.authDir = opts.authDir ?? process.env.WA_AUTH_DIR ?? DEFAULT_AUTH_DIR;
    this.publishFn =
      opts.publish ??
      ((p) => {
        void publishWaStatus(this.redis, p);
      });
    this.depsInput = opts.deps;
    this.reconnectDelayMs =
      opts.reconnectDelayMs ??
      ((attempt) => Math.min(60_000, 2000 * 2 ** attempt));
    this.verbose = opts.verbose ?? false;
  }

  // ---------------- siklus hidup ----------------

  private async requireDeps(): Promise<BaileysDeps> {
    if (!this.depsCache) {
      this.depsCache = await (this.depsInput ?? getRealBaileysDeps());
    }
    return this.depsCache;
  }

  private log(...args: unknown[]): void {
    if (this.verbose) console.info("[BaileysGateway]", ...args);
  }

  /** Mulai koneksi. Idempoten: tidak membuat socket kedua bila sudah jalan. */
  async connect(): Promise<void> {
    if (this.sock || this.isReconnecting) return;
    this.manualClose = false;
    await this.emit({ status: "connecting", reason: "manual-connect" });
    await this.startSocket();
  }

  /** Putuskan koneksi dengan rapi; tidak reconnect otomatis. */
  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.clearReconnectTimer();
    await this.teardownSocket();
    await this.emit({ status: "close", reason: "manual" });
  }

  /**
   * Logout: hapus isi direktori auth + putuskan koneksi + mulai ulang
   * sehingga QR baru terbit di dashboard.
   */
  async logout(): Promise<void> {
    this.clearReconnectTimer();
    await this.teardownSocket();
    this.clearAuthDir();
    await setWaRestricted(this.redis, false);
    this.selfPhone = undefined;
    this.selfLid = undefined;
    this.manualClose = false;
    await this.emit({ status: "connecting", reason: "logout" });
    await this.startSocket();
  }

  /** Restart: tutup socket lama lalu konek ulang (tanpa hapus auth). */
  async restart(): Promise<void> {
    this.clearReconnectTimer();
    await this.teardownSocket();
    await setWaRestricted(this.redis, false);
    this.manualClose = false;
    await this.emit({ status: "connecting", reason: "restart" });
    await this.startSocket();
  }

  /** Buat socket baru. Guard isReconnecting mencegah dua upaya paralel (anti 440). */
  private async startSocket(): Promise<void> {
    if (this.isReconnecting || this.manualClose) return;
    this.isReconnecting = true;
    try {
      await this.teardownSocket();
      const deps = await this.requireDeps();
      const { state, saveCreds } = await deps.useMultiFileAuthState(
        this.authDir,
      );
      let version: unknown;
      try {
        ({ version } = await deps.fetchLatestBaileysVersion());
      } catch {
        version = undefined; // offline saat start: coba versi default baileys
      }
      const opts: BaileysSocketOptions = {
        version: version as BaileysSocketOptions["version"],
        auth: state,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        logger: makeSocketLogger(
          this.verbose,
        ) as unknown as BaileysSocketOptions["logger"],
        browser: ["Reza AI", "Chrome", "1.0.0"],
      };
      // Proxy egress opsional (mis. sandbox di balik HTTP proxy):
      // set WA_PROXY_URL=http://user:pass@host:3128 agar WebSocket Baileys
      // lewat proxy. Tidak diset di produksi/VPS (koneksi langsung).
      const proxyUrl = process.env.WA_PROXY_URL;
      if (proxyUrl) {
        const { HttpsProxyAgent } = await import("https-proxy-agent");
        (opts as Record<string, unknown>).agent = new HttpsProxyAgent(
          proxyUrl,
        );
        console.log("[BaileysGateway] memakai proxy egress untuk WebSocket.");
      }
      const sock = deps.makeWASocket(opts);
      this.sock = sock;
      sock.ev.on("creds.update", () => {
        saveCreds().catch((e) =>
          console.error("[BaileysGateway] saveCreds gagal:", e),
        );
      });
      sock.ev.on("connection.update", (u) =>
        this.handleSocketConnectionUpdate(sock, u),
      );
      sock.ev.on("messages.upsert", (u) => this.onMessagesUpsert(sock, u));
      this.log("socket dibuat, menunggu update koneksi…");
    } finally {
      this.isReconnecting = false;
    }
  }

  private handleSocketConnectionUpdate(
    emitting: MinimalSocket,
    update: ConnectionUpdateLike,
  ): void {
    if (emitting !== this.sock) return; // abaikan event dari socket basi
    if (update.qr) {
      this.attempt = 0; // server merespons: reset backoff
      void this.emit({ status: "qr", qr: update.qr });
      return;
    }
    if (update.connection === "open") {
      void this.handleOpen(emitting);
      return;
    }
    if (update.connection === "close") {
      void this.handleClose(update.lastDisconnect);
    }
  }

  private async handleOpen(sock: MinimalSocket): Promise<void> {
    this.isReconnecting = false;
    this.attempt = 0;
    this.clearReconnectTimer();
    const rawId = sock.user?.id ?? "";
    const { pn, lid } = normalizeJid(rawId);
    this.selfPhone = pn || undefined;
    this.selfLid = lid;
    const name = sock.user?.name;
    this.log(`terhubung: ${name ?? "?"} (${pn || lid || "?"})`);
    await this.emit({
      status: "open",
      phone: this.selfPhone,
      name,
    });
  }

  private async handleClose(lastDisconnect?: {
    error?: { output?: { statusCode?: number }; statusCode?: number };
  }): Promise<void> {
    const code =
      lastDisconnect?.error?.output?.statusCode ??
      lastDisconnect?.error?.statusCode;
    await this.teardownSocket();

    if (this.manualClose) {
      await this.emit({ status: "close", reason: "manual" });
      return;
    }

    // 463: akun dibatasi WhatsApp — flag + status, tanpa auto-reconnect.
    if (code === 463) {
      await setWaRestricted(this.redis, true);
      this.log("akun dibatasi WhatsApp (463)");
      await this.emit({ status: "restricted", reason: "463" });
      return;
    }

    const deps = await this.requireDeps();
    // loggedOut (401): sesi dicabut dari HP — bersihkan auth, QR baru.
    if (code === deps.DisconnectReason.loggedOut) {
      this.log("loggedOut dari HP — membersihkan direktori auth");
      this.clearAuthDir();
      await setWaRestricted(this.redis, false);
      this.selfPhone = undefined;
      this.selfLid = undefined;
      await this.emit({ status: "connecting", reason: "logged-out" });
      await this.startSocket();
      return;
    }

    // Tutup biasa / error jaringan: coba lagi dengan backoff.
    this.log(`koneksi tertutup (kode ${code ?? "?"}), menjadwalkan reconnect…`);
    await this.emit({
      status: "connecting",
      reason: code ? String(code) : "close",
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer || this.isReconnecting) return;
    const delay = this.reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.startSocket().catch((e) =>
        console.error("[BaileysGateway] reconnect gagal:", e),
      );
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async teardownSocket(): Promise<void> {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      sock.ev.removeAllListeners();
    } catch {
      // abaikan
    }
    try {
      sock.ws.close();
    } catch {
      // abaikan
    }
  }

  private clearAuthDir(): void {
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
      fs.mkdirSync(this.authDir, { recursive: true });
      this.log(`direktori auth dibersihkan: ${this.authDir}`);
    } catch (e) {
      console.error("[BaileysGateway] gagal membersihkan auth dir:", e);
    }
  }

  // ---------------- status ----------------

  private async emit(
    payload: Omit<WaStatusPayload, "ts">,
  ): Promise<void> {
    const full: WaStatusPayload = { ...payload, ts: Date.now() };
    this.lastStatus = full.status;
    for (const h of this.statusHandlers) {
      try {
        h(full);
      } catch {
        // abaikan
      }
    }
    try {
      await this.publishFn(full);
    } catch (e) {
      console.error("[BaileysGateway] publish status gagal:", e);
    }
    const mapped: "open" | "close" | "connecting" =
      full.status === "open"
        ? "open"
        : full.status === "close" || full.status === "restricted"
          ? "close"
          : "connecting";
    for (const h of this.connectionHandlers) {
      try {
        h(mapped);
      } catch {
        // abaikan
      }
    }
  }

  /** Status koneksi terakhir yang dipublish. */
  getConnectionState(): WaConnectionStatus {
    return this.lastStatus;
  }

  /** Nomor sendiri (E.164 tanpa "+"), bila identitas PN tersedia. */
  getSelfPhone(): string | undefined {
    return this.selfPhone;
  }

  /** Daftarkan handler status lengkap (payload WaStatusPayload). */
  onStatus(handler: (p: WaStatusPayload) => void): void {
    this.statusHandlers.push(handler);
  }

  /** Cek flag pembatasan akun (463) di Redis. */
  async isRestricted(): Promise<boolean> {
    return readRestrictedFlag(this.redis);
  }

  // ---------------- pesan ----------------

  private requireSocket(): MinimalSocket {
    if (!this.sock) throw new Error("WhatsApp belum terhubung.");
    return this.sock;
  }

  private async assertNotRestricted(): Promise<void> {
    if (await this.isRestricted()) {
      throw new Error(
        "Akun WhatsApp sedang dibatasi (error 463) — pengiriman ditahan.",
      );
    }
  }

  async send(to: string, body: string): Promise<SendResult> {
    await this.assertNotRestricted();
    const sock = this.requireSocket();
    const sent = await sock.sendMessage(pnToJid(to), { text: body });
    const messageId = sent?.key?.id ?? `local-${Date.now()}`;
    this.noteSent(messageId);
    return { messageId };
  }

  async sendMedia(
    to: string,
    filePath: string,
    caption?: string,
  ): Promise<SendResult> {
    await this.assertNotRestricted();
    const sock = this.requireSocket();
    const ext = path.extname(filePath).toLowerCase();
    const jid = pnToJid(to);
    let content: unknown;
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
      content = { image: { url: filePath }, caption };
    } else if ([".mp4", ".mov", ".3gp"].includes(ext)) {
      content = { video: { url: filePath }, caption };
    } else if ([".mp3", ".ogg", ".opus", ".m4a"].includes(ext)) {
      content = { audio: { url: filePath }, mimetype: "audio/mp4" };
    } else {
      content = {
        document: { url: filePath },
        mimetype: "application/octet-stream",
        fileName: path.basename(filePath),
        caption,
      };
    }
    const sent = await sock.sendMessage(jid, content);
    const messageId = sent?.key?.id ?? `local-${Date.now()}`;
    this.noteSent(messageId);
    return { messageId };
  }

  async presence(to: string, state: PresenceState): Promise<void> {
    const sock = this.requireSocket();
    await sock.sendPresenceUpdate(state, pnToJid(to));
  }

  async downloadMedia(message: InboundMessage): Promise<Buffer> {
    const raw = this.rawCache.get(message.id);
    if (!raw) {
      throw new Error(
        `Pesan ${message.id} tidak ada di cache — mungkin sudah terlalu lama.`,
      );
    }
    const deps = await this.requireDeps();
    return deps.downloadMediaMessage(raw, "buffer", {});
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onConnectionUpdate(
    handler: (status: "open" | "close" | "connecting") => void,
  ): void {
    this.connectionHandlers.push(handler);
  }

  private onMessagesUpsert(
    emitting: MinimalSocket,
    upsert: MessagesUpsertLike,
  ): void {
    if (emitting !== this.sock) return;
    if (upsert.type !== "notify") return;
    for (const raw of upsert.messages ?? []) {
      const rawId = raw.key?.id;
      // Cermin kiriman gateway sendiri: Baileys menggemakan pesan fromMe
      // yang baru kita kirim — sudah dicatat worker saat mengirim,
      // jadi dilewati agar tidak dobel. Pesan fromMe lain = dari HP.
      if (raw.key.fromMe && rawId && this.isOwnRecentSend(rawId)) continue;
      let msg: InboundMessage | null;
      try {
        msg = this.normalizeInbound(raw);
      } catch (e) {
        console.error("[BaileysGateway] normalisasi pesan gagal:", e);
        continue;
      }
      if (!msg) continue;
      // LID tanpa PN: coba resolve via mapping Baileys sebelum diteruskan.
      // Tanpa ini kontak tampil sebagai "lid:<angka>".
      if (!msg.from && msg.lid) {
        const sock = this.sock;
        this.resolvePnForLid(sock, msg.lid)
          .then((pn) => {
            if (pn) msg!.from = pn.replace(/\D/g, "");
            this.dispatchMessage(msg!);
          })
          .catch((e) =>
            console.error("[BaileysGateway] resolve LID gagal:", e),
          );
        this.rawCache.set(msg.id, raw as unknown as WAMessage);
        continue;
      }
      this.rawCache.set(msg.id, raw as unknown as WAMessage);
      if (this.rawCache.size > MAX_RAW_CACHE) {
        const oldest = this.rawCache.keys().next().value;
        if (oldest) this.rawCache.delete(oldest);
      }
      this.dispatchMessage(msg);
    }
  }

  /** Kirim pesan ternormalisasi ke semua handler. */
  private dispatchMessage(msg: InboundMessage): void {
    for (const h of this.messageHandlers) {
      Promise.resolve(h(msg)).catch((e) =>
        console.error("[BaileysGateway] message handler gagal:", e),
      );
    }
  }

  /** Resolve LID -> nomor via mapping internal Baileys (null bila tak dikenal). */
  private async resolvePnForLid(
    sock: MinimalSocket | null,
    lid: string,
  ): Promise<string | null> {
    try {
      const pn = await sock?.signalRepository?.lidMapping?.getPNForLID(lid);
      return typeof pn === "string" && pn ? pn : null;
    } catch {
      return null;
    }
  }

  /**
   * Normalisasi pesan Baileys -> InboundMessage.
   *
   * Melewatkan: pesan tanpa isi.
   * TIDAK lagi melewatkan fromMe / grup / status broadcast (berubah di
   * Task 5): pesan fromMe yang bukan cermin kiriman gateway = pesan dari
   * HP (source "phone"); grup & status diteruskan ke ingest yang
   * menandainya Chat.ignored=true (tetap tersimpan).
   *
   * Catatan LID: bila pengirim @lid, `from` kosong dan `lid` terisi —
   * ingest (Task 5) mengisi mapping LID<->PN via tabel Contact.
   */
  normalizeInbound(raw: RawMessageLike): InboundMessage | null {
    const m = raw.message;
    if (!m) return null;
    const remoteJid = raw.key.remoteJid ?? "";
    if (!remoteJid) return null;
    const fromMe = raw.key.fromMe === true;

    const { pn, lid } = normalizeJid(remoteJid);
    const id = raw.key.id ?? `${Date.now()}`;

    let body: string | undefined;
    let mediaType: InboundMessage["mediaType"];
    const textOf = (v: unknown): string | undefined =>
      typeof v === "string" && v.length > 0 ? v : undefined;

    const conv = m["conversation"];
    const ext = m["extendedTextMessage"] as
      | { text?: unknown; contextInfo?: { stanzaId?: unknown } }
      | undefined;
    if (typeof conv === "string") {
      body = textOf(conv);
    } else if (ext) {
      body = textOf(ext.text);
    }
    const img = m["imageMessage"] as { caption?: unknown } | undefined;
    const vid = m["videoMessage"] as { caption?: unknown } | undefined;
    const aud = m["audioMessage"] as Record<string, unknown> | undefined;
    const doc = m["documentMessage"] as Record<string, unknown> | undefined;
    const stk = m["stickerMessage"] as Record<string, unknown> | undefined;
    if (img) {
      mediaType = "image";
      body = textOf(img.caption);
    } else if (vid) {
      mediaType = "video";
      body = textOf(vid.caption);
    } else if (aud) {
      mediaType = "audio";
    } else if (doc) {
      mediaType = "document";
    } else if (stk) {
      mediaType = "sticker";
    }

    let quotedId: string | undefined;
    const ctxOf = (node: unknown): { stanzaId?: unknown } | undefined => {
      if (typeof node !== "object" || node === null) return undefined;
      const ci = (node as Record<string, unknown>)["contextInfo"];
      return typeof ci === "object" && ci !== null
        ? (ci as { stanzaId?: unknown })
        : undefined;
    };
    for (const node of [ext, img, vid, aud, doc, stk]) {
      const stanzaId = ctxOf(node)?.stanzaId;
      if (typeof stanzaId === "string" && stanzaId) {
        quotedId = stanzaId;
        break;
      }
    }

    const tsRaw = raw.messageTimestamp;
    const tsSec =
      typeof tsRaw === "number"
        ? tsRaw
        : typeof tsRaw === "bigint"
          ? Number(tsRaw)
          : Date.now() / 1000;

    return {
      id,
      from: pn,
      lid,
      senderName:
        typeof raw.pushName === "string" && raw.pushName ? raw.pushName : undefined,
      body,
      mediaType,
      quotedId,
      timestamp: Math.floor(tsSec * 1000),
      fromMe,
      source: fromMe ? "phone" : "wa",
      chatJid: remoteJid,
    };
  }
}
