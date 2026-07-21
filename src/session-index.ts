import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Durable sessionId → project mapping.
 *
 * The in-process tools layer needs to resolve which project a sessionId belongs
 * to. Holding that only in memory means a daemon restart mid-session orphans
 * every in-flight session ("Unknown Peon session"). This index persists the
 * mapping to disk so sessions survive restarts.
 *
 * Writes are serialized through a queue; each write rewrites the full JSON map
 * (fine for a local single-user tool). Ended sessions are removed to keep the
 * file small; a crash may leave a stale "active" entry, which `prune` clears.
 */

export interface SessionIndexRecord {
  sessionId: string;
  projectPath: string;
  client: string;
  cwd: string;
  startedAt: string;
}

export function defaultSessionIndexPath(): string {
  return join(homedir(), "Library", "Application Support", "Peon", "sessions-index.json");
}

export class SessionIndex {
  private cache?: Map<string, SessionIndexRecord>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = defaultSessionIndexPath()) {}

  async get(sessionId: string): Promise<SessionIndexRecord | undefined> {
    return (await this.load()).get(sessionId);
  }

  async set(record: SessionIndexRecord): Promise<void> {
    const map = await this.load();
    map.set(record.sessionId, record);
    await this.persist(map);
  }

  async remove(sessionId: string): Promise<void> {
    const map = await this.load();
    if (map.delete(sessionId)) await this.persist(map);
  }

  async active(): Promise<SessionIndexRecord[]> {
    return [...(await this.load()).values()];
  }

  /** Drop sessions older than maxAgeMs (stale entries from crashed runs). */
  async prune(now: number, maxAgeMs: number): Promise<number> {
    const map = await this.load();
    let removed = 0;
    for (const [id, record] of map) {
      const started = Date.parse(record.startedAt);
      if (Number.isFinite(started) && now - started > maxAgeMs) {
        map.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) await this.persist(map);
    return removed;
  }

  private async load(): Promise<Map<string, SessionIndexRecord>> {
    if (this.cache) return this.cache;
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    const map = new Map<string, SessionIndexRecord>();
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          for (const value of Object.values(parsed as Record<string, unknown>)) {
            if (isSessionIndexRecord(value)) map.set(value.sessionId, value);
          }
        }
      } catch {
        // Corrupt index → start clean rather than blocking all session resolution.
      }
    }
    this.cache = map;
    return map;
  }

  private async persist(map: Map<string, SessionIndexRecord>): Promise<void> {
    this.cache = map;
    const snapshot = Object.fromEntries(map);
    const write = async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}

function isSessionIndexRecord(value: unknown): value is SessionIndexRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.projectPath === "string" &&
    typeof record.client === "string" &&
    typeof record.cwd === "string" &&
    typeof record.startedAt === "string"
  );
}
