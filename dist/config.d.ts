export type PeonProvider = "openrouter" | "openai" | "anthropic" | "ollama";
export interface PeonConfig {
    /** LLM provider for consolidation (+ embeddings where supported). */
    provider: PeonProvider;
    /** Generic API key (falls back to provider-specific env vars). */
    llmApiKey?: string;
    /** OpenAI-compatible chat/embeddings base URL for the provider. */
    llmBaseUrl: string;
    openRouterApiKey?: string;
    processingModel: string;
    embeddingModel?: string;
    embeddingMode: "off" | "local" | "api" | "ollama";
    /** Ollama server for local semantic embeddings (embeddingMode "ollama"). */
    ollamaBaseUrl?: string;
    memoryDirName: string;
    flushMinChars: number;
    aiMode: "off" | "gated";
    /** Deadline for one consolidation request (PEON_LLM_TIMEOUT_MS). */
    llmTimeoutMs?: number;
    /** Consolidations allowed at once across projects (PEON_CONSOLIDATION_CONCURRENCY);
     *  unset means 1 for a local provider, 2 for a hosted one. */
    consolidationConcurrency?: number;
    /** How long a prompt waits for its query embedding before ranking lexically
     *  (PEON_QUERY_EMBED_TIMEOUT_MS). */
    queryEmbedTimeoutMs?: number;
}
type Env = Record<string, string | undefined>;
export declare function loadPeonConfig(env?: Env): PeonConfig;
export declare function readEnvFile(startDir?: string): Env;
/**
 * Is an LLM available for optional AI passes (compression, entity extraction, HyDE,
 * global extraction)?
 *
 * These used to gate on `openRouterApiKey`, which meant a fully-local setup
 * (PEON_PROVIDER=ollama, no OpenRouter key) silently skipped every one of them —
 * "local mode" was not actually local. A local provider needs no key; a hosted one does.
 */
export declare function llmEnabled(config: PeonConfig): boolean;
/** The chat-completions endpoint for the configured provider. */
export declare function llmEndpoint(config: PeonConfig): string;
/** Auth + content headers for the configured provider (local providers need no key). */
export declare function llmHeaders(config: PeonConfig): Record<string, string>;
export {};
