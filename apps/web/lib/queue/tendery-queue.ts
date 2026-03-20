import { Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const TENDERY_QUEUE_NAME = "tendery" as const;

/** После загрузки файла закупки в S3 — регистрация в воркере (Шаг 3). */
export const JOB_TENDER_FILE_REGISTERED = "tender.fileRegistered" as const;

export const JOB_TENDER_EXTRACT_TEXT = "tender.extractText" as const;

let queue: Queue | null = null;

export function getTenderyQueue(): Queue {
  if (!queue) {
    queue = new Queue(TENDERY_QUEUE_NAME, {
      connection: { url: redisUrl }
    });
  }
  return queue;
}

export async function enqueueTenderFileRegistered(tenderFileId: string): Promise<void> {
  const q = getTenderyQueue();
  await q.add(
    JOB_TENDER_FILE_REGISTERED,
    { tenderFileId },
    {
      removeOnComplete: 100,
      removeOnFail: 500
    }
  );
}

export async function enqueueTenderExtractText(tenderFileId: string): Promise<void> {
  const q = getTenderyQueue();
  await q.add(
    JOB_TENDER_EXTRACT_TEXT,
    { tenderFileId },
    {
      removeOnComplete: 100,
      removeOnFail: 500
    }
  );
}
