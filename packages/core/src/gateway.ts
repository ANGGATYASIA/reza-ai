/** Pesan masuk dari WhatsApp (dinormalisasi dari event Baileys). */
export interface InboundMessage {
  /** ID pesan WhatsApp (untuk dedup). */
  id: string;
  /** Nomor pengirim, E.164 tanpa "+" (kolom Contact.pn). */
  from: string;
  /** LID pengirim bila tersedia. */
  lid?: string;
  /** Isi teks (caption untuk media). */
  body?: string;
  /** Jenis media bila ada. */
  mediaType?: "image" | "video" | "audio" | "document" | "sticker";
  /** ID pesan yang di-reply, bila ada. */
  quotedId?: string;
  /** Waktu pesan (ms epoch). */
  timestamp: number;
  /**
   * True bila pesan dikirim dari akun sendiri (mis. diketik di HP).
   * BaileysGateway mengisi ini untuk pesan fromMe yang BUKAN hasil
   * kirim gateway (lihat cache pesan terkirim) — Task 5 mencatatnya
   * dengan source "phone".
   */
  fromMe?: boolean;
  /**
   * Asal pesan: "wa" (default, masuk dari jaringan WhatsApp) atau
   * "phone" (dikirim/diketik dari HP pemilik, terdeteksi via fromMe).
   * Nilai "dashboard"/"ai" hanya dipakai saat MENYIMPAN, bukan di sini.
   */
  source?: "wa" | "phone";
  /**
   * JID percakapan mentah (mis. "62812@s.whatsapp.net", "123@lid",
   * "120363...@g.us", "status@broadcast"). Dipakai ingest untuk
   * mendeteksi grup/broadcast. Bila kosong, diturunkan dari from/lid.
   */
  chatJid?: string;
}

export interface SendResult {
  messageId: string;
}

export type PresenceState = "composing" | "paused" | "recording" | "available" | "unavailable";

/**
 * Kontrak gateway WhatsApp. Task 1 hanya mendefinisikan interface;
 * implementasi Baileys (dan Fake untuk test) dikerjakan di Task 4.
 */
export interface WhatsAppGateway {
  /** Hubungkan ke WhatsApp (QR/pairing ditangani implementasi). */
  connect(): Promise<void>;
  /** Putuskan koneksi dengan rapi. */
  disconnect(): Promise<void>;

  /** Kirim pesan teks ke nomor E.164 tanpa "+". */
  send(to: string, body: string): Promise<SendResult>;
  /** Kirim media dari path lokal + caption opsional. */
  sendMedia(to: string, path: string, caption?: string): Promise<SendResult>;

  /** Tampilkan status mengetik / berhenti mengetik. */
  presence(to: string, state: PresenceState): Promise<void>;

  /** Unduh media pesan masuk; kembalikan buffer mentah. */
  downloadMedia(message: InboundMessage): Promise<Buffer>;

  /** Daftarkan handler pesan masuk. */
  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void;

  /** Daftarkan handler perubahan status koneksi. */
  onConnectionUpdate?(
    handler: (status: "open" | "close" | "connecting") => void,
  ): void;
}
