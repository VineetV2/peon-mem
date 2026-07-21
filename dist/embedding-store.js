import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash } from "./embeddings.js";
export class EmbeddingStore {
    filePath;
    // mtime-keyed cache so the (multi-MB) sidecar isn't re-read+parsed on every prompt's
    // read-only retrieval. Invalidated by mtime change (incl. our own atomic persist).
    cache;
    constructor(filePath) {
        this.filePath = filePath;
    }
    static async open(memoryDir) {
        const filePath = join(memoryDir, "brain", "embeddings.jsonl");
        await mkdir(dirname(filePath), { recursive: true });
        const store = new EmbeddingStore(filePath);
        return store;
    }
    async load() {
        let mtimeMs = 0;
        try {
            mtimeMs = (await stat(this.filePath)).mtimeMs;
        }
        catch {
            mtimeMs = 0; // missing file → treat as empty, mtime 0
        }
        if (this.cache && this.cache.mtimeMs === mtimeMs)
            return this.cache.map;
        const raw = await readFile(this.filePath, "utf8").catch(() => "");
        const map = new Map();
        for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const stored = parseStoredLine(JSON.parse(trimmed));
                if (stored)
                    map.set(stored.id, stored);
            }
            catch {
                // skip malformed lines — never let a bad vector block retrieval
            }
        }
        this.cache = { mtimeMs, map };
        return map;
    }
    /**
     * Ensure every record has a current embedding. Recomputes only what changed,
     * prunes vectors for deleted records, persists the result, and returns the
     * id → vector map ready for hybrid ranking. Embedding failures degrade to an
     * empty map rather than throwing (retrieval falls back to lexical-only).
     */
    async sync(records, client) {
        if (!client) {
            return { vectorById: new Map(), computed: 0, reused: 0, pruned: 0 };
        }
        const existing = await this.load();
        const liveIds = new Set(records.map((record) => record.id));
        const pruned = [...existing.keys()].filter((id) => !liveIds.has(id)).length;
        const toCompute = [];
        let reused = 0;
        for (const record of records) {
            const prior = existing.get(record.id);
            if (prior && prior.model === client.model && prior.hash === contentHash(embeddingText(record))) {
                reused += 1;
            }
            else {
                toCompute.push(record);
            }
        }
        const result = new Map();
        for (const record of records) {
            const prior = existing.get(record.id);
            if (prior && prior.model === client.model && prior.hash === contentHash(embeddingText(record))) {
                result.set(record.id, prior);
            }
        }
        let computed = 0;
        if (toCompute.length > 0) {
            try {
                const vectors = await client.embed(toCompute.map((record) => embeddingText(record)));
                toCompute.forEach((record, i) => {
                    result.set(record.id, {
                        id: record.id,
                        model: client.model,
                        hash: contentHash(embeddingText(record)),
                        vector: vectors[i] ?? []
                    });
                });
                computed = toCompute.length;
            }
            catch {
                // On a hard failure, keep whatever we already had and continue lexical-only.
            }
        }
        // Only touch disk when the vector set actually changed.
        if (computed > 0 || pruned > 0) {
            await this.persist(records, result);
        }
        const vectorById = new Map();
        for (const [id, stored] of result)
            vectorById.set(id, stored.vector);
        return { vectorById, computed, reused, pruned };
    }
    /** Read vectors without recomputing — used by read-only retrieval paths. */
    async vectorById() {
        const stored = await this.load();
        const map = new Map();
        for (const [id, value] of stored)
            map.set(id, value.vector);
        return map;
    }
    async persist(records, result) {
        // Write in record order for stable diffs; only persist vectors we actually have.
        const lines = records
            .map((record) => result.get(record.id))
            .filter((value) => Boolean(value))
            // Persist the vector as base64 float32 (`vec`), ~4x smaller and ~4x faster to parse than a
            // JSON float64 array. Legacy `vector`-array lines are still read on load and get re-encoded
            // to `vec` here on their next persist (lazy migration; no separate migration step needed).
            .map((value) => JSON.stringify({ id: value.id, model: value.model, hash: value.hash, vec: encodeVector(value.vector) }));
        // Atomic write (tmp + rename) so a crash mid-write can't truncate the sidecar.
        const tmp = `${this.filePath}.tmp`;
        await writeFile(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
        await rename(tmp, this.filePath);
        this.cache = undefined; // invalidate; next load() re-reads the fresh file
    }
}
/** Embed the record type alongside content so type acts as a soft semantic anchor. */
function embeddingText(record) {
    const entities = record.entities.length > 0 ? ` ${record.entities.join(" ")}` : "";
    return `${record.type}: ${record.content}${entities}`;
}
/** Serialize a vector as base64 of its float32 bytes — ~4x smaller + faster to parse than JSON float64. */
export function encodeVector(vector) {
    return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}
/** Decode a base64 float32 vector back to number[]; null on malformed/misaligned input. */
export function decodeVector(b64) {
    try {
        const buf = Buffer.from(b64, "base64");
        if (buf.byteLength === 0 || buf.byteLength % 4 !== 0)
            return null;
        return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
    catch {
        return null;
    }
}
/**
 * Parse one sidecar line into a StoredEmbedding, accepting BOTH the current base64-float32 `vec`
 * form and the legacy JSON-array `vector` form (so old sidecars keep working until re-persisted).
 */
function parseStoredLine(value) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    if (typeof record.id !== "string" || typeof record.model !== "string" || typeof record.hash !== "string")
        return null;
    let vector = null;
    if (typeof record.vec === "string") {
        vector = decodeVector(record.vec);
    }
    else if (Array.isArray(record.vector) && record.vector.every((entry) => typeof entry === "number")) {
        vector = record.vector;
    }
    if (!vector)
        return null;
    return { id: record.id, model: record.model, hash: record.hash, vector };
}
