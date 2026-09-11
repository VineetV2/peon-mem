import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash } from "./embeddings.js";
/**
 * Bounded registry of live sidecar caches.
 *
 * The cache below keeps a whole embeddings.jsonl parsed in memory so read-only
 * retrieval doesn't re-parse a multi-MB file on every prompt. That is a real win,
 * but the daemon holds one store per project and nothing evicted: a heap snapshot
 * showed 8 stores pinning 60,288 Float32Array vectors / 338 MB of native backing,
 * with RSS past 1.9 GB — enough GC pressure to peg the CPU and stop the daemon
 * answering. So caches are now LRU-bounded and released once idle; a dropped cache
 * costs one re-read, never correctness.
 */
const MAX_CACHED_STORES = Number(process.env.PEON_EMBED_CACHE_STORES) > 0
    ? Number(process.env.PEON_EMBED_CACHE_STORES)
    : 2;
const CACHE_TTL_MS = Number(process.env.PEON_EMBED_CACHE_TTL_MS) > 0
    ? Number(process.env.PEON_EMBED_CACHE_TTL_MS)
    : 5 * 60 * 1000;
/** Insertion order is LRU order: least-recently-used first. */
const liveCaches = new Map();
let diskReads = 0;
function touchCache(store, at) {
    liveCaches.delete(store);
    liveCaches.set(store, at);
    pruneCaches(at);
}
function pruneCaches(now) {
    for (const [store, touchedAt] of [...liveCaches]) {
        if (now - touchedAt > CACHE_TTL_MS) {
            store.dropCache();
            liveCaches.delete(store);
        }
    }
    while (liveCaches.size > MAX_CACHED_STORES) {
        const oldest = liveCaches.keys().next().value;
        if (!oldest)
            break;
        oldest.dropCache();
        liveCaches.delete(oldest);
    }
}
// TTL alone only fires on activity, so an idle daemon would hold its last caches
// forever. A low-frequency sweeper lets a quiet daemon settle back down; unref'd
// so it never keeps the process alive on its own.
const sweeper = setInterval(() => pruneCaches(Date.now()), 60_000);
if (typeof sweeper.unref === "function")
    sweeper.unref();
export function embeddingCacheStats() {
    return {
        cachedStores: liveCaches.size,
        diskReads,
        reads: diskReads,
        expireOlderThan: (now) => pruneCaches(now)
    };
}
/** Test helper: forget every cached sidecar. */
export function resetEmbeddingCaches() {
    for (const store of [...liveCaches.keys()])
        store.dropCache();
    liveCaches.clear();
    diskReads = 0;
}
/** Real output width per embedding model, learned once per process. */
const modelDimensions = new Map();
/** Test helper: forget learned widths, simulating a fresh daemon process. */
export function resetEmbeddingDimensionCache() {
    modelDimensions.clear();
}
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
        if (this.cache && this.cache.mtimeMs === mtimeMs) {
            touchCache(this, Date.now());
            return this.cache.map;
        }
        diskReads += 1;
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
        touchCache(this, Date.now());
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
        // A stored vector can carry the right model name and hash yet the wrong width —
        // that is exactly what a degraded fallback wrote — and cosineSimilarity scores any
        // width mismatch as 0, so those records vanish from semantic recall without ever
        // erroring. Width is part of validity, so we need to know the client's real width.
        //
        // Learning it must not cost a round trip on every sync: the width is cached per
        // model for the process, and only probed when there is nothing to compute (the
        // one case where a fully-poisoned sidecar would otherwise look entirely reusable).
        let expectedDim = modelDimensions.get(client.model) ?? 0;
        const nothingToRecompute = records.every((record) => {
            const prior = existing.get(record.id);
            return prior && prior.model === client.model && prior.hash === contentHash(embeddingText(record));
        });
        if (expectedDim === 0 && records.length > 0 && nothingToRecompute) {
            try {
                const probe = await client.embed([embeddingText(records[0])]);
                if (!client.degraded && probe[0]?.length) {
                    expectedDim = probe[0].length;
                    modelDimensions.set(client.model, expectedDim);
                }
            }
            catch {
                expectedDim = 0; // cannot probe — fall back to model+hash validity only
            }
        }
        const validDim = (vector) => expectedDim === 0 || vector.length === expectedDim;
        const toCompute = [];
        let reused = 0;
        for (const record of records) {
            const prior = existing.get(record.id);
            if (prior &&
                prior.model === client.model &&
                prior.hash === contentHash(embeddingText(record)) &&
                validDim(prior.vector)) {
                reused += 1;
            }
            else {
                toCompute.push(record);
            }
        }
        const result = new Map();
        for (const record of records) {
            const prior = existing.get(record.id);
            if (prior &&
                prior.model === client.model &&
                prior.hash === contentHash(embeddingText(record)) &&
                validDim(prior.vector)) {
                result.set(record.id, prior);
            }
        }
        let computed = 0;
        if (toCompute.length > 0) {
            try {
                const vectors = await client.embed(toCompute.map((record) => embeddingText(record)));
                // A degraded run returns local trigram vectors. Serving them for THIS call is
                // fine (graceful degradation); writing them under the primary's model name is
                // not — they would be reused forever as if they were real embeddings.
                if (client.degraded) {
                    const degradedById = new Map();
                    for (const [id, stored] of result)
                        degradedById.set(id, stored.vector);
                    toCompute.forEach((record, i) => {
                        const vector = vectors[i];
                        if (vector)
                            degradedById.set(record.id, vector);
                    });
                    return { vectorById: degradedById, computed: 0, reused, pruned };
                }
                toCompute.forEach((record, i) => {
                    result.set(record.id, {
                        id: record.id,
                        model: client.model,
                        hash: contentHash(embeddingText(record)),
                        vector: vectors[i] ?? []
                    });
                });
                computed = toCompute.length;
                const width = vectors[0]?.length ?? 0;
                if (width > 0)
                    modelDimensions.set(client.model, width);
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
    /** Release this store's parsed sidecar. Costs one re-read, never correctness. */
    dropCache() {
        this.cache = undefined;
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
        liveCaches.delete(this);
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
        // Return the Float32Array itself rather than Array.from(...): a number[] stores every
        // dimension as a double, doubling memory and copying 28k vectors on every cold load.
        // slice() so the vector owns its bytes instead of pinning Node's shared Buffer pool.
        return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
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
