import { Worker } from "bullmq";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

type JobNames = "tender.extractText" | "tender.parse" | "tender.aiAnalyze";

const worker = new Worker(
  "tendery",
  async (job) => {
    switch (job.name as JobNames) {
      case "tender.extractText": {
        return { ok: true };
      }
      case "tender.parse": {
        return { ok: true };
      }
      case "tender.aiAnalyze": {
        return { ok: true };
      }
      default: {
        throw new Error(`Unknown job name: ${job.name}`);
      }
    }
  },
  {
    connection: { url: redisUrl }
  }
);

worker.on("ready", () => {
  // eslint-disable-next-line no-console
  console.log(`[worker] ready (redis=${redisUrl})`);
});

worker.on("failed", (job, err) => {
  // eslint-disable-next-line no-console
  console.error("[worker] job failed", { jobId: job?.id, name: job?.name, err });
});

