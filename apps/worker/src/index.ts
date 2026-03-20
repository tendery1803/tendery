import { Worker } from "bullmq";
import { PrismaClient } from "@tendery/db";
import { extractFromBuffer, getExtractionConfigFromEnv } from "@tendery/extraction";
import { downloadObjectToBuffer } from "./s3.js";
import { enqueueTenderExtractText } from "./tendery-queue.js";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const prisma = new PrismaClient();

type JobNames =
  | "tender.extractText"
  | "tender.parse"
  | "tender.aiAnalyze"
  | "tender.fileRegistered";

const worker = new Worker(
  "tendery",
  async (job) => {
    switch (job.name as JobNames) {
      case "tender.extractText": {
        const tenderFileId = (job.data as { tenderFileId?: string })?.tenderFileId;
        if (!tenderFileId) {
          throw new Error("tender.extractText: missing tenderFileId");
        }

        const row = await prisma.tenderFile.findUnique({
          where: { id: tenderFileId }
        });
        if (!row) {
          return { ok: false, reason: "file_not_found" };
        }
        if (row.fileStatus !== "registration_done") {
          return { ok: false, reason: "unexpected_file_status", status: row.fileStatus };
        }
        if (row.extractionStatus === "done") {
          return { ok: true, skipped: true };
        }

        await prisma.tenderFile.update({
          where: { id: tenderFileId },
          data: { extractionStatus: "processing" }
        });

        try {
          const config = getExtractionConfigFromEnv();
          let buffer: Buffer;
          try {
            buffer = await downloadObjectToBuffer(row.storageKey);
          } catch (e) {
            const msg = `s3_download:${String(e)}`;
            await prisma.tenderFile.update({
              where: { id: tenderFileId },
              data: {
                extractionStatus: "failed",
                extractionError: msg,
                extractedAt: new Date()
              }
            });
            throw e;
          }

          const outcome = await extractFromBuffer({
            filename: row.originalName,
            mime: row.contentType,
            buffer,
            config
          });

          const now = new Date();

          switch (outcome.kind) {
            case "ok":
              await prisma.tenderFile.update({
                where: { id: tenderFileId },
                data: {
                  extractionStatus: "done",
                  extractedText: outcome.text,
                  extractionError: null,
                  extractedAt: now
                }
              });
              break;
            case "skipped":
              await prisma.tenderFile.update({
                where: { id: tenderFileId },
                data: {
                  extractionStatus: "skipped_unsupported",
                  extractionError: outcome.reason,
                  extractedText: null,
                  extractedAt: now
                }
              });
              break;
            case "quarantined":
              await prisma.tenderFile.update({
                where: { id: tenderFileId },
                data: {
                  extractionStatus: "quarantined",
                  extractionError: outcome.reason,
                  extractedText: null,
                  extractedAt: now
                }
              });
              break;
            case "error":
              await prisma.tenderFile.update({
                where: { id: tenderFileId },
                data: {
                  extractionStatus: "failed",
                  extractionError: outcome.message,
                  extractedText: null,
                  extractedAt: now
                }
              });
              break;
            default: {
              const _e: never = outcome;
              throw new Error(`unexpected outcome ${String(_e)}`);
            }
          }

          return { ok: true };
        } catch (e) {
          const existing = await prisma.tenderFile.findUnique({
            where: { id: tenderFileId },
            select: { extractionStatus: true }
          });
          if (existing?.extractionStatus === "processing") {
            await prisma.tenderFile.update({
              where: { id: tenderFileId },
              data: {
                extractionStatus: "failed",
                extractionError: `exception:${String(e)}`,
                extractedAt: new Date()
              }
            });
          }
          throw e;
        }
      }
      case "tender.parse": {
        return { ok: true };
      }
      case "tender.aiAnalyze": {
        return { ok: true };
      }
      case "tender.fileRegistered": {
        const tenderFileId = (job.data as { tenderFileId?: string })?.tenderFileId;
        if (!tenderFileId) {
          throw new Error("tender.fileRegistered: missing tenderFileId");
        }
        const row = await prisma.tenderFile.findUnique({
          where: { id: tenderFileId }
        });
        if (!row) {
          return { ok: false, reason: "file_not_found" };
        }
        if (row.fileStatus !== "stored") {
          return { ok: false, reason: "unexpected_status", status: row.fileStatus };
        }
        await prisma.tenderFile.update({
          where: { id: tenderFileId },
          data: {
            fileStatus: "registration_done",
            registrationNote: `registered_at=${new Date().toISOString()}`,
            extractionStatus: "pending"
          }
        });
        await enqueueTenderExtractText(tenderFileId);
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
