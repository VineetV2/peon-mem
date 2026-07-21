import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const LOCAL_EMBEDDING_DIM = 256;
export const LOCAL_EMBEDDING_MODEL = "peon-local-trigram-v1";
/** Cosine similarity of two vectors. Returns 0 for empty/mismatched/zero vectors. */
export function cosineSimilarity(a, b) {
    if (a.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0)
        return 0;
    const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return Number.isFinite(sim) ? sim : 0;
}
/** L2-normalize a vector in place-safe fashion (returns a new array). */
export function l2normalize(vector) {
    let norm = 0;
    for (const value of vector)
        norm += value * value;
    norm = Math.sqrt(norm);
    if (norm === 0)
        return vector.slice();
    return vector.map((value) => value / norm);
}
/**
 * Deterministic local embedding: hashed character trigrams folded into a fixed
 * dimensional, L2-normalized vector. Two texts that share character trigrams end
 * up with a high cosine similarity, giving robust fuzzy lexical matching offline.
 */
export function localEmbed(text, dim = LOCAL_EMBEDDING_DIM) {
    const vector = new Array(dim).fill(0);
    const normalized = ` ${text.toLowerCase().replace(/\s+/g, " ").trim()} `;
    if (normalized.trim().length === 0)
        return vector;
    // Character trigrams capture morphology and tolerate typos/substrings.
    for (let i = 0; i + 3 <= normalized.length; i += 1) {
        const gram = normalized.slice(i, i + 3);
        const bucket = fnv1aInt(gram) % dim;
        // Signed contribution reduces hash-collision cancellation bias.
        const sign = (fnv1aInt(`sign:${gram}`) & 1) === 0 ? 1 : -1;
        vector[bucket] += sign;
    }
    // Whole-token bucketing adds a coarse lexical signal on top of trigrams.
    for (const token of normalized.split(" ").filter((t) => t.length > 1)) {
        const bucket = fnv1aInt(`tok:${token}`) % dim;
        vector[bucket] += 2;
    }
    return l2normalize(vector);
}
/** Stable content hash used to detect when a record's embedding must be recomputed. */
export function contentHash(text) {
    return fnv1aHex(text.trim());
}
export class LocalEmbeddingClient {
    dim;
    model = LOCAL_EMBEDDING_MODEL;
    constructor(dim = LOCAL_EMBEDDING_DIM) {
        this.dim = dim;
    }
    async embed(texts) {
        return texts.map((text) => localEmbed(text, this.dim));
    }
}
/**
 * Module-level LRU for SINGLE-text embeddings (query-shaped calls). Every prompt's retrieval
 * embeds the user query via a remote round-trip — serve telemetry measured it at ~1.4s of the
 * injection latency — and the same queries recur constantly (hook boilerplate like "recent
 * project context…", "Continue", repeated user questions). Same model+text is deterministic, so
 * caching is correctness-free; it cuts BOTH the latency and the OpenRouter spend, and makes eval
 * reruns of the same qrels deterministic (removes live-query-embedding noise from ledger A/Bs).
 * Keyed by model + contentHash(text); capped; daemon-lifetime (stores are cached per project).
 */
const QUERY_EMBED_CACHE_MAX = 512; // ~12KB/vector → ≤ ~6MB in memory
const queryEmbedCache = new Map();
// PERSISTED across restarts/processes: an append-only JSONL sidecar (base64 float32), so repeat
// queries stay free-and-fast after a daemon restart and eval scripts reuse the daemon's vectors
// (zero marginal OpenRouter spend for known queries). Append-only by design — never rewritten or
// deleted; on load we read the TAIL (newest wins) so unbounded growth can't hurt startup.
const QUERY_EMBED_CACHE_FILE = process.env.PEON_QUERY_EMBED_CACHE ||
    join(homedir(), "Library", "Application Support", "Peon", "query-embeddings.jsonl");
const PERSIST_READ_TAIL_BYTES = 8 * 1024 * 1024;
let persistedLoaded = false;
function b64encode(vector) {
    return Buffer.from(new Float32Array(vector).buffer).toString("base64");
}
function b64decode(b64) {
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
function loadPersistedOnce() {
    if (persistedLoaded)
        return;
    persistedLoaded = true;
    try {
        const size = statSync(QUERY_EMBED_CACHE_FILE).size;
        const fd = openSync(QUERY_EMBED_CACHE_FILE, "r");
        try {
            const len = Math.min(size, PERSIST_READ_TAIL_BYTES);
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, size - len);
            let text = buf.toString("utf8");
            if (len < size)
                text = text.slice(text.indexOf("\n") + 1); // drop partial first line
            for (const line of text.split(/\r?\n/)) {
                if (!line.trim())
                    continue;
                try {
                    const row = JSON.parse(line);
                    const vec = typeof row.v === "string" ? b64decode(row.v) : null;
                    if (row.k && vec)
                        queryEmbedCache.set(row.k, vec); // newest wins (later lines overwrite)
                }
                catch { /* skip bad line */ }
            }
            // enforce the in-memory cap (keep the newest entries)
            while (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
                const oldest = queryEmbedCache.keys().next().value;
                if (oldest === undefined)
                    break;
                queryEmbedCache.delete(oldest);
            }
        }
        finally {
            closeSync(fd);
        }
    }
    catch { /* no cache file yet / unreadable → start empty */ }
}
function cacheKey(model, text) {
    return `${model}:${contentHash(text)}`;
}
function cacheGet(key) {
    loadPersistedOnce();
    const hit = queryEmbedCache.get(key);
    if (hit) {
        // refresh recency (Map preserves insertion order → delete+set = LRU touch)
        queryEmbedCache.delete(key);
        queryEmbedCache.set(key, hit);
    }
    return hit;
}
function cachePut(key, vector) {
    if (queryEmbedCache.size >= QUERY_EMBED_CACHE_MAX) {
        const oldest = queryEmbedCache.keys().next().value;
        if (oldest !== undefined)
            queryEmbedCache.delete(oldest);
    }
    queryEmbedCache.set(key, vector);
    try {
        mkdirSync(dirname(QUERY_EMBED_CACHE_FILE), { recursive: true });
        appendFileSync(QUERY_EMBED_CACHE_FILE, JSON.stringify({ k: key, v: b64encode(vector) }) + "\n");
    }
    catch { /* persistence is best-effort — never fail an embed over it */ }
}
export class OpenRouterEmbeddingClient {
    model;
    apiKey;
    fetchImpl;
    constructor(options) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        // Cache single-text (query) calls — the per-prompt hot path. Batch (document sync) calls
        // pass through untouched.
        const key = texts.length === 1 ? cacheKey(this.model, texts[0]) : null;
        if (key) {
            const hit = cacheGet(key);
            if (hit)
                return [hit];
        }
        const response = await this.fetchImpl("https://openrouter.ai/api/v1/embeddings", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ model: this.model, input: texts })
        });
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            throw new Error(`OpenRouter embeddings failed with ${response.status}${body ? `: ${body}` : ""}`);
        }
        const json = (await response.json());
        const data = json.data ?? [];
        if (data.length !== texts.length) {
            throw new Error(`OpenRouter embeddings returned ${data.length} vectors for ${texts.length} inputs.`);
        }
        // Preserve input order even if the API returns an index field out of order.
        const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
        const vectors = ordered.map((item, i) => {
            const vector = item.embedding;
            if (!Array.isArray(vector) || vector.length === 0) {
                throw new Error(`OpenRouter embeddings returned an empty vector at index ${i}.`);
            }
            return l2normalize(vector);
        });
        if (key && vectors.length === 1)
            cachePut(key, vectors[0]);
        return vectors;
    }
}
/**
 * Local semantic embeddings via an Ollama server (default http://127.0.0.1:11434).
 * Same quality class as API embeddings but ~30ms on-machine instead of a ~1.3s remote
 * round-trip, zero API spend, fully offline. Model is part of the cache/sidecar hash,
 * so switching models auto-triggers document re-embeds through the existing sync path.
 */
export class OllamaEmbeddingClient {
    model;
    baseUrl;
    fetchImpl;
    constructor(options) {
        this.model = options.model;
        this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const key = texts.length === 1 ? cacheKey(this.model, texts[0]) : null;
        if (key) {
            const hit = cacheGet(key);
            if (hit)
                return [hit];
        }
        // Chunk large batches — a whole-brain re-embed (thousands of texts) in one request
        // overwhelms the local server; ~64 per call keeps each request small and streams progress.
        const CHUNK = 64;
        const vectors = [];
        for (let start = 0; start < texts.length; start += CHUNK) {
            const slice = texts.slice(start, start + CHUNK);
            const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: this.model, input: slice })
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Ollama embeddings failed with ${response.status}${body ? `: ${body}` : ""}`);
            }
            const json = (await response.json());
            const data = json.embeddings ?? [];
            if (data.length !== slice.length) {
                throw new Error(`Ollama embeddings returned ${data.length} vectors for ${slice.length} inputs.`);
            }
            for (let i = 0; i < data.length; i += 1) {
                const vector = data[i];
                if (!Array.isArray(vector) || vector.length === 0) {
                    throw new Error(`Ollama embeddings returned an empty vector at index ${start + i}.`);
                }
                vectors.push(l2normalize(vector));
            }
        }
        if (key && vectors.length === 1)
            cachePut(key, vectors[0]);
        return vectors;
    }
}
/**
 * Resilient client that tries the API client first and transparently falls back
 * to local embeddings on any error, so a flaky network never blocks memory writes.
 */
export class FallbackEmbeddingClient {
    primary;
    fallback;
    onFallback;
    model;
    constructor(primary, fallback = new LocalEmbeddingClient(), onFallback) {
        this.primary = primary;
        this.fallback = fallback;
        this.onFallback = onFallback;
        this.model = primary.model;
    }
    async embed(texts) {
        try {
            return await this.primary.embed(texts);
        }
        catch (error) {
            this.onFallback?.(error);
            return this.fallback.embed(texts);
        }
    }
}
/** Build the embedding client implied by config, or null when embeddings are off. */
export function createEmbeddingClient(options) {
    const { config } = options;
    if (config.embeddingMode === "off")
        return null;
    if (config.embeddingMode === "ollama") {
        // Local semantic embeddings. Fall back to the API client (if configured) then trigram-local,
        // so a stopped Ollama service degrades instead of breaking retrieval.
        const ollama = new OllamaEmbeddingClient({
            model: config.embeddingModel ?? "nomic-embed-text",
            baseUrl: config.ollamaBaseUrl
        });
        const fallback = config.openRouterApiKey && config.embeddingModel && config.embeddingModel.includes("/")
            ? new FallbackEmbeddingClient(new OpenRouterEmbeddingClient({ apiKey: config.openRouterApiKey, model: config.embeddingModel }), new LocalEmbeddingClient(), options.onFallback)
            : new LocalEmbeddingClient();
        return new FallbackEmbeddingClient(ollama, fallback, options.onFallback);
    }
    if (config.embeddingMode === "api" && config.openRouterApiKey && config.embeddingModel) {
        const primary = new OpenRouterEmbeddingClient({
            apiKey: config.openRouterApiKey,
            model: config.embeddingModel
        });
        return new FallbackEmbeddingClient(primary, new LocalEmbeddingClient(), options.onFallback);
    }
    // Default and "api"-without-credentials both resolve to deterministic local embeddings.
    return new LocalEmbeddingClient();
}
function fnv1aInt(value) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
function fnv1aHex(value) {
    return fnv1aInt(value).toString(16).padStart(8, "0");
}
