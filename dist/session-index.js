import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export function defaultSessionIndexPath() {
    return join(homedir(), "Library", "Application Support", "Peon", "sessions-index.json");
}
export class SessionIndex {
    filePath;
    cache;
    writeQueue = Promise.resolve();
    constructor(filePath = defaultSessionIndexPath()) {
        this.filePath = filePath;
    }
    async get(sessionId) {
        return (await this.load()).get(sessionId);
    }
    async set(record) {
        const map = await this.load();
        map.set(record.sessionId, record);
        await this.persist(map);
    }
    async remove(sessionId) {
        const map = await this.load();
        if (map.delete(sessionId))
            await this.persist(map);
    }
    async active() {
        return [...(await this.load()).values()];
    }
    /** Drop sessions older than maxAgeMs (stale entries from crashed runs). */
    async prune(now, maxAgeMs) {
        const map = await this.load();
        let removed = 0;
        for (const [id, record] of map) {
            const started = Date.parse(record.startedAt);
            if (Number.isFinite(started) && now - started > maxAgeMs) {
                map.delete(id);
                removed += 1;
            }
        }
        if (removed > 0)
            await this.persist(map);
        return removed;
    }
    async load() {
        if (this.cache)
            return this.cache;
        const raw = await readFile(this.filePath, "utf8").catch(() => "");
        const map = new Map();
        if (raw.trim()) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    for (const value of Object.values(parsed)) {
                        if (isSessionIndexRecord(value))
                            map.set(value.sessionId, value);
                    }
                }
            }
            catch {
                // Corrupt index → start clean rather than blocking all session resolution.
            }
        }
        this.cache = map;
        return map;
    }
    async persist(map) {
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
function isSessionIndexRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return (typeof record.sessionId === "string" &&
        typeof record.projectPath === "string" &&
        typeof record.client === "string" &&
        typeof record.cwd === "string" &&
        typeof record.startedAt === "string");
}
