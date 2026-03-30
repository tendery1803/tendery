import { appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";

const SESSION_ID = "7d64fb";
const LOG_DIR = join(process.cwd(), "logs");
const LOG_PATH = join(LOG_DIR, `debug-${SESSION_ID}.log`);

type DebugLogPayload = {
  sessionId: string;
  id?: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: number;
  hypothesisId?: string;
};

async function ensureDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
}

export function appendDebugLog(payload: Omit<DebugLogPayload, "sessionId" | "timestamp"> & { timestamp?: number }) {
  const entry: DebugLogPayload = {
    sessionId: SESSION_ID,
    timestamp: payload.timestamp ?? Date.now(),
    ...payload
  };
  const line = JSON.stringify(entry) + "\n";
  void ensureDir()
    .then(() => appendFile(LOG_PATH, line))
    .catch(() => {
      /* swallow */
    });
}
