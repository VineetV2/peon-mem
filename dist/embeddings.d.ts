import type { PeonConfig } from "./config.js";
/**
 * Peon embeddings layer.
 *
 * Provides vector embeddings for memory records so retrieval can rank by meaning,
 * not just keyword overlap. Designed local-first:
 *
 *   - "local" mode (default): deterministic hashed character-trigram embeddings.
 *     No API key, no network, fully offline. Captures fuzzy/lexical similarity
 *     (typos, substrings, shared word stems) in vector space. Deterministic, so
 *     tests are stable and identical content always yields identical vectors.
 *
 *   - "api" mode: real semantic embeddings via the OpenRouter embeddings endpoint.
 *     Falls back to local embeddings on any failure so the pipeline never breaks.
 *
 *   - "off" mode: no embeddings; retrieval stays purely lexical.
 */
export type EmbeddingVector = number[] | Float32Array;
export declare const LOCAL_EMBEDDING_DIM = 256;
export declare const LOCAL_EMBEDDING_MODEL = "peon-local-trigram-v1";
export interface EmbeddingClient {
    readonly model: string;
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
export declare const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 2000;
export declare const DEFAULT_EMBED_TIMEOUT_MS = 90000;
/**
 * Embed a prompt's query, but never make the prompt wait longer than `timeoutMs`.
 *
 * Every prompt embeds its query before ranking. With the embedder on a small home server
 * that is busy generating a consolidation, that took 26-40 s, and the prompt waited the
 * whole time. Past the deadline, or on any failure, this returns undefined and retrieval
 * ranks lexically. A request that misses the deadline keeps running, so a query-embedding
 * cache still fills and the same query is instant next time.
 */
export declare function embedQueryWithin(client: EmbeddingClient, query: string, timeoutMs: number): Promise<EmbeddingVector | undefined>;
/** Cosine similarity of two vectors. Returns 0 for empty/mismatched/zero vectors. */
export declare function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number;
/** L2-normalize a vector in place-safe fashion (returns a new array). */
export declare function l2normalize(vector: EmbeddingVector): EmbeddingVector;
/**
 * Deterministic local embedding: hashed character trigrams folded into a fixed
 * dimensional, L2-normalized vector. Two texts that share character trigrams end
 * up with a high cosine similarity, giving robust fuzzy lexical matching offline.
 */
export declare function localEmbed(text: string, dim?: number): EmbeddingVector;
/** Stable content hash used to detect when a record's embedding must be recomputed. */
export declare function contentHash(text: string): string;
export declare class LocalEmbeddingClient implements EmbeddingClient {
    private readonly dim;
    readonly model = "peon-local-trigram-v1";
    constructor(dim?: number);
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
export interface OpenRouterEmbeddingClientOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
}
export declare class OpenRouterEmbeddingClient implements EmbeddingClient {
    readonly model: string;
    private readonly apiKey;
    private readonly fetchImpl;
    private readonly baseUrl;
    constructor(options: OpenRouterEmbeddingClientOptions);
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
export interface OllamaEmbeddingClientOptions {
    model: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    /** Deadline for one embedding request (PEON_EMBED_TIMEOUT_MS). */
    requestTimeoutMs?: number;
}
export declare class OllamaEmbeddingClient implements EmbeddingClient {
    readonly model: string;
    private readonly baseUrl;
    private readonly fetchImpl;
    private readonly requestTimeoutMs;
    constructor(options: OllamaEmbeddingClientOptions);
    /**
     * One embedding request, bounded, with one retry on a fresh connection.
     *
     * Measured live: Ollama answered a 64-text batch in seconds, but the ~310 KB response sat
     * in the server's TCP send queue on that one keep-alive connection and never arrived, while
     * a fresh connection carried the same payload in 3.3 s. Node's fetch waits 300 s for
     * response headers, so every such request stalled a consolidation for five minutes. The
     * deadline also covers reading the body. HTTP errors are real answers and are not retried.
     */
    private fetchEmbeddings;
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
/**
 * Resilient client that tries the API client first and transparently falls back
 * to local embeddings on any error, so a flaky network never blocks memory writes.
 */
export declare class FallbackEmbeddingClient implements EmbeddingClient {
    private readonly primary;
    private readonly fallback;
    private readonly onFallback?;
    readonly model: string;
    /**
     * True when the most recent embed() degraded to the fallback. The vectors it
     * returns are a different model AND a different width, so persisting them under
     * the primary's name makes them indistinguishable from real ones — every later
     * sync then "reuses" trigram vectors as if they were embeddings, and retrieval
     * silently scores them 0 (cosineSimilarity returns 0 on a length mismatch).
     * Callers that persist vectors must check this and skip writing.
     */
    degraded: boolean;
    constructor(primary: EmbeddingClient, fallback?: EmbeddingClient, onFallback?: ((error: unknown) => void) | undefined);
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
export type EmbeddingMode = PeonConfig["embeddingMode"];
export interface CreateEmbeddingClientOptions {
    config: Pick<PeonConfig, "embeddingMode" | "embeddingModel" | "openRouterApiKey" | "ollamaBaseUrl" | "provider" | "llmApiKey" | "llmBaseUrl"> & Partial<Pick<PeonConfig, "embedTimeoutMs">>;
    onFallback?: (error: unknown) => void;
}
/** Build the embedding client implied by config, or null when embeddings are off. */
/**
 * What was asked for versus what will actually run.
 *
 * Peon degrades to deterministic local trigram embeddings whenever the configured
 * embedder is unavailable. That is deliberate — retrieval keeps working — but it was
 * silent, and a silent downgrade is indistinguishable from working correctly while
 * semantic recall quietly collapses. Two real incidents: an Ollama blip embedding 30k+
 * records with trigram vectors, and a script whose .env was not found resolving to
 * "local" with no warning at all.
 */
export interface EmbeddingPlan {
    intended: PeonConfig["embeddingMode"];
    effective: "off" | "local" | "api" | "ollama";
    downgraded: boolean;
    reason?: string;
}
/** Only the fields the decision actually depends on, matching the client factory. */
export type EmbeddingPlanInput = Pick<PeonConfig, "embeddingMode" | "embeddingModel" | "openRouterApiKey" | "provider" | "llmApiKey">;
export declare function resolveEmbeddingPlan(config: EmbeddingPlanInput): EmbeddingPlan;
/** Test helper: forget which downgrade warnings have already been emitted. */
export declare function resetEmbeddingWarnings(): void;
export declare function createEmbeddingClient(options: CreateEmbeddingClientOptions): EmbeddingClient | null;
