/**
 * 8 antrian BullMQ Reza AI.
 * Nama queue di-Redis memakai prefix "reza:" via QUEUE_PREFIX.
 * "wa-command" (Task 4): perintah dashboard -> worker untuk koneksi
 * WhatsApp ("logout" | "restart").
 */
export const QUEUE_NAMES = [
  "inbound",
  "ai-reply",
  "send",
  "ingest",
  "followup",
  "digest",
  "reindex",
  "wa-command",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(name: string): name is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(name);
}
