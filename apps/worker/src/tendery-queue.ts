import { Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const TENDERY_QUEUE_NAME = "tendery" as const;

let queue: Queue | null = null;

export function getTenderyQueue(): Queue {
  if (!queue) {
    queue = new Queue(TENDERY_QUEUE_NAME, {
      connection: { url: redisUrl }
    });
  }
  return queue;
}

export async function enqueueTenderExtractText(
  tenderFileId: string,
  backgroundJobId: string
): Promise<void> {
  const q = getTenderyQueue();
  await q.add(
    "tender.extractText",
    { tenderFileId, backgroundJobId },
    {
      removeOnComplete: 100,
      removeOnFail: 500
    }
  );
}
