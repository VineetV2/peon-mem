import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const DEFAULT_LOG_DIR = join(homedir(), "Library", "Logs", "Peon");
/**
 * Reads are bounded to the tail of the log. recent() used to slurp the entire
 * file and split it, which meant a months-old 100 MB daemon.jsonl blocked the
 * event loop on every monitor poll (flattening a 100 MB rope + allocating ~400k
 * strings, only to throw all but `limit` of them away). Same tail-read strategy
  * the query-embedding cache already uses.
 *
 * Sized to comfortably cover the largest real caller (token-stat seeding asks
 * for 50k entries; entries average ~260 bytes), so bounding reads does not
 * silently truncate what the daemon rebuilds on boot.
 */
const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;
/** Rotate before the live file can reach a size that hurts anything. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export class PeonLogger {
    logFile;
    maxBytes;
    tailBytes;
    writeQueue = Promise.resolve();
    bytesWritten = 0;
    sizeKnown = false;
    constructor(options = {}) {
        this.logFile = join(options.logDir ?? DEFAULT_LOG_DIR, "daemon.jsonl");
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.tailBytes = options.tailBytes ?? DEFAULT_TAIL_BYTES;
    }
    async log(type, fields = {}) {
        const entry = {
            id: crypto.randomUUID(),
            type,
            createdAt: new Date().toISOString(),
            ...sanitize(fields)
        };
        await this.enqueueWrite(`${JSON.stringify(entry)}\n`);
        return entry;
    }
    /**
     * Newest-first entries from the tail of the log. Cost is bounded by
     * `tailBytes`, not by the size of the file, so this stays flat as the log
     * grows. Entries older than the tail window are not visible here — the log
     * file itself (and its rotated siblings) remain the full record.
     */
    async recent(limit = 100) {
        const text = await this.readTail();
        return text
            .split("\n")
            .filter(Boolean)
            .slice(-limit)
            .reverse()
            .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            }
            catch {
                // Skips both genuinely corrupt lines and the partial first line left
                // by seeking into the middle of a record.
                return [];
            }
        });
    }
    async readTail() {
        let handle;
        try {
            const size = (await stat(this.logFile)).size;
            const length = Math.min(size, this.tailBytes);
            if (length === 0)
                return "";
            handle = await open(this.logFile, "r");
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, size - length);
            const text = buffer.toString("utf8");
            // A partial leading line is unavoidable when the window starts mid-record.
            return length < size ? text.slice(text.indexOf("\n") + 1) : text;
        }
        catch {
            return "";
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    /**
     * Move the live log aside once it exceeds maxBytes. History is preserved in a
     * timestamped sibling rather than truncated, so nothing is lost.
     */
    async rotateIfNeeded() {
        if (this.bytesWritten <= this.maxBytes)
            return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await rename(this.logFile, `${this.logFile}.${stamp}`).catch(() => undefined);
        this.bytesWritten = 0;
    }
    async enqueueWrite(line) {
        const write = async () => {
            try {
                await mkdir(dirname(this.logFile), { recursive: true });
                // Adopt the on-disk size once, so a daemon restart doesn't forget that
                // an already-huge log is due for rotation.
                if (!this.sizeKnown) {
                    this.bytesWritten = await stat(this.logFile).then((s) => s.size).catch(() => 0);
                    this.sizeKnown = true;
                }
                await this.rotateIfNeeded();
                await appendFile(this.logFile, line, "utf8");
                this.bytesWritten += Buffer.byteLength(line, "utf8");
            }
            catch {
                // Best-effort logging: a log write failure must never crash the daemon
                // or reject a request handler.
            }
        };
        this.writeQueue = this.writeQueue.then(write);
        return this.writeQueue;
    }
}
function sanitize(fields) {
    return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
        if (key.toLowerCase().includes("key") || key.toLowerCase().includes("authorization")) {
            return [key, "[redacted]"];
        }
        if (typeof value === "string" && value.length > 1200) {
            return [key, `${value.slice(0, 1200)}...`];
        }
        return [key, value];
    }));
}
