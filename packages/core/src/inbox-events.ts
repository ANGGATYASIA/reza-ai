import type Redis from "ioredis";

/**
 * Event realtime kotak masuk (Task 8 memindahkan dari ingest.ts ke sini
 * supaya ai-pipeline.ts bisa menerbitkannya tanpa import siklis).
 *
 * Channel Redis yang dibaca SSE /api/inbox/stream.
 */
export const INBOX_CHANNEL = "reza:inbox";

export interface InboxEvent {
  chatId: string;
  /** messageId opsional untuk event yang tidak terikat satu pesan. */
  messageId?: string;
  type:
    | "new-message"
    | "chat-updated"
    | "draft-created"
    | "handoff-created";
  ts: number;
}

/** Publish event ke channel inbox. Mengembalikan jumlah subscriber. */
export async function publishInboxEvent(
  redis: Redis,
  ev: Omit<InboxEvent, "ts"> & { ts?: number },
): Promise<number> {
  return redis.publish(
    INBOX_CHANNEL,
    JSON.stringify({ ...ev, ts: ev.ts ?? Date.now() }),
  );
}
