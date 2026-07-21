import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PeonLoggerOptions {
  logDir?: string;
}

export interface PeonLogEntry {
  id: string;
  type: string;
  createdAt: string;
  [key: string]: unknown;
}

const DEFAULT_LOG_DIR = join(homedir(), "Library", "Logs", "Peon");

export class PeonLogger {
  private readonly logFile: string;
  private writeQueue = Promise.resolve();

  constructor(options: PeonLoggerOptions = {}) {
    this.logFile = join(options.logDir ?? DEFAULT_LOG_DIR, "daemon.jsonl");
  }

  async log(type: string, fields: Record<string, unknown> = {}): Promise<PeonLogEntry> {
    const entry: PeonLogEntry = {
      id: crypto.randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      ...sanitize(fields)
    };
    await this.enqueueWrite(`${JSON.stringify(entry)}\n`);
    return entry;
  }

  async recent(limit = 100): Promise<PeonLogEntry[]> {
    const raw = await readFile(this.logFile, "utf8").catch(() => "");
    return raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .reverse()
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as PeonLogEntry];
        } catch {
          return [];
        }
      });
  }

  private async enqueueWrite(line: string): Promise<void> {
    const write = async () => {
      try {
        await mkdir(this.logFile.slice(0, this.logFile.lastIndexOf("/")), { recursive: true });
        await appendFile(this.logFile, line, "utf8");
      } catch {
        // Best-effort logging: a log write failure must never crash the daemon
        // or reject a request handler.
      }
    };
    this.writeQueue = this.writeQueue.then(write);
    return this.writeQueue;
  }
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("authorization")) {
        return [key, "[redacted]"];
      }
      if (typeof value === "string" && value.length > 1200) {
        return [key, `${value.slice(0, 1200)}...`];
      }
      return [key, value];
    })
  );
}
