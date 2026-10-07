import type {
  InboundMessage,
  PresenceState,
  SendResult,
  WhatsAppGateway,
} from "./gateway.js";

/**
 * FakeGateway — implementasi WhatsAppGateway murni in-memory.
 * Seluruh logika AI/CRM (Task 6+) diuji dengan ini: tanpa jaringan,
 * tanpa QR, tanpa akun WhatsApp asli.
 *
 * - send/sendMedia/presence/downloadMedia: dicatat, bisa di-assert.
 * - simulateIncoming(): memicu handler onMessage seperti pesan asli.
 * - setConnectionStatus(): mengubah status + memicu onConnectionUpdate.
 */
export class FakeGateway implements WhatsAppGateway {
  readonly sentTexts: Array<{ to: string; body: string; id: string }> = [];
  readonly sentMedia: Array<{
    to: string;
    path: string;
    caption?: string;
    id: string;
  }> = [];
  readonly presenceCalls: Array<{ to: string; state: PresenceState }> = [];
  readonly downloadCalls: InboundMessage[] = [];

  connectionStatus: "open" | "close" | "connecting" = "close";
  connected = false;

  private messageHandlers: Array<(msg: InboundMessage) => void | Promise<void>> =
    [];
  private connectionHandlers: Array<
    (status: "open" | "close" | "connecting") => void
  > = [];
  private counter = 0;
  /**
   * Penanda unik per instance agar ID pesan tidak tabrakan antar
   * FakeGateway dalam satu database (mis. antar skenario test).
   */
  private readonly instanceTag = Math.random().toString(36).slice(2, 6);
  /**
   * ID pesan yang dikirim gateway ini (id -> timestamp ms). Cermin dari
   * BaileysGateway: pesan fromMe yang id-nya ada di sini = hasil kirim
   * gateway (sudah dicatat worker) — bukan pesan dari HP.
   */
  private readonly sentIds = new Map<string, number>();

  async connect(): Promise<void> {
    this.connected = true;
    this.setConnectionStatus("open");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.setConnectionStatus("close");
  }

  async send(to: string, body: string): Promise<SendResult> {
    if (!this.connected) throw new Error("FakeGateway belum connect()");
    this.counter += 1;
    const id = `fake-msg-${this.counter}-${this.instanceTag}`;
    this.sentTexts.push({ to, body, id });
    this.sentIds.set(id, Date.now());
    return { messageId: id };
  }

  async sendMedia(
    to: string,
    path: string,
    caption?: string,
  ): Promise<SendResult> {
    if (!this.connected) throw new Error("FakeGateway belum connect()");
    this.counter += 1;
    const id = `fake-media-${this.counter}-${this.instanceTag}`;
    this.sentMedia.push({ to, path, caption, id });
    this.sentIds.set(id, Date.now());
    return { messageId: id };
  }

  async presence(to: string, state: PresenceState): Promise<void> {
    this.presenceCalls.push({ to, state });
  }

  async downloadMedia(message: InboundMessage): Promise<Buffer> {
    this.downloadCalls.push(message);
    return Buffer.from(`fake-media-bytes:${message.id}`);
  }

  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  onConnectionUpdate(
    handler: (status: "open" | "close" | "connecting") => void,
  ): void {
    this.connectionHandlers.push(handler);
  }

  /** Test helper: simulasikan pesan masuk dari nomor tertentu. */
  async simulateIncoming(msg: InboundMessage): Promise<void> {
    for (const h of this.messageHandlers) {
      await h(msg);
    }
  }

  /**
   * True bila id ini dikirim via gateway ini dalam `withinMs` terakhir
   * (default 15 menit). Dipakai worker/harness untuk membedakan cermin
   * kiriman gateway sendiri dari pesan yang diketik di HP.
   */
  wasRecentlySent(messageId: string, withinMs = 15 * 60 * 1000): boolean {
    const ts = this.sentIds.get(messageId);
    if (ts === undefined) return false;
    if (Date.now() - ts >= withinMs) {
      this.sentIds.delete(messageId);
      return false;
    }
    return true;
  }

  /** Test helper: ubah status koneksi + beri tahu subscriber. */
  setConnectionStatus(status: "open" | "close" | "connecting"): void {
    this.connectionStatus = status;
    for (const h of this.connectionHandlers) {
      h(status);
    }
  }

  /** Bersihkan semua catatan (antar skenario test). */
  reset(): void {
    this.sentTexts.length = 0;
    this.sentMedia.length = 0;
    this.presenceCalls.length = 0;
    this.downloadCalls.length = 0;
    this.sentIds.clear();
    this.counter = 0;
  }
}
