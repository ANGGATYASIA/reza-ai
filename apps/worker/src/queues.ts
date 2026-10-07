import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import { QUEUE_NAMES, QUEUE_PREFIX, type QueueName } from "@reza-ai/core";

export interface QueueRegistry {
  queues: Record<QueueName, Queue>;
  workers: Record<QueueName, Worker>;
  close(): Promise<void>;
}

/** Prosesor asli untuk sebuah antrian (menggantikan placeholder). */
export type QueueProcessor = (job: Job) => Promise<unknown>;

/**
 * Mendaftarkan 8 antrian Reza AI + worker.
 * Tanpa `processors`, worker hanya me-log job yang masuk (placeholder);
 * Task 4 mengisi prosesor asli untuk "wa-command", task berikutnya
 * menyusul untuk antrian lain.
 */
export function registerQueues(
  connection: ConnectionOptions,
  processors?: Partial<Record<QueueName, QueueProcessor>>,
): QueueRegistry {
  const queues = {} as Record<QueueName, Queue>;
  const workers = {} as Record<QueueName, Worker>;

  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, { connection, prefix: QUEUE_PREFIX });
    workers[name] = new Worker(
      name,
      async (job) => {
        const processor = processors?.[name];
        if (processor) {
          await processor(job);
          return;
        }
        // Placeholder — prosesor asli (inbound, ai-reply, dst.)
        // diimplementasikan di task berikutnya.
        console.log(`[worker:${name}] job ${job.id} (${job.name}) diterima — belum diproses (placeholder)`);
      },
      { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
    );
    workers[name].on("failed", (job, err) => {
      console.error(`[worker:${name}] job ${job?.id} gagal:`, err.message);
    });
    workers[name].on("error", (err) => {
      console.error(`[worker:${name}] error:`, err.message);
    });
  }

  return {
    queues,
    workers,
    async close() {
      await Promise.all(Object.values(workers).map((w) => w.close()));
      await Promise.all(Object.values(queues).map((q) => q.close()));
    },
  };
}
