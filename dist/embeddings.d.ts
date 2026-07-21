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
export type EmbeddingVector = number[];
export declare const LOCAL_EMBEDDING_DIM = 256;
export declare const LOCAL_EMBEDDING_MODEL = "peon-local-trigram-v1";
export interface EmbeddingClient {
    readonly model: string;
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
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
}
/**
 * Local semantic embeddings via an Ollama server (default http://127.0.0.1:11434).
 * Same quality class as API embeddings but ~30ms on-machine instead of a ~1.3s remote
 * round-trip, zero API spend, fully offline. Model is part of the cache/sidecar hash,
 * so switching models auto-triggers document re-embeds through the existing sync path.
 */
export declare class OllamaEmbeddingClient implements EmbeddingClient {
    readonly model: string;
    private readonly baseUrl;
    private readonly fetchImpl;
    constructor(options: OllamaEmbeddingClientOptions);
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
    constructor(primary: EmbeddingClient, fallback?: EmbeddingClient, onFallback?: ((error: unknown) => void) | undefined);
    embed(texts: string[]): Promise<EmbeddingVector[]>;
}
export type EmbeddingMode = PeonConfig["embeddingMode"];
export interface CreateEmbeddingClientOptions {
    config: Pick<PeonConfig, "embeddingMode" | "embeddingModel" | "openRouterApiKey" | "ollamaBaseUrl" | "provider" | "llmApiKey" | "llmBaseUrl">;
    onFallback?: (error: unknown) => void;
}
/** Build the embedding client implied by config, or null when embeddings are off. */
export declare function createEmbeddingClient(options: CreateEmbeddingClientOptions): EmbeddingClient | null;
