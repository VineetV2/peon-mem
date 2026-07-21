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
}
type Env = Record<string, string | undefined>;
export declare function loadPeonConfig(env?: Env): PeonConfig;
export declare function readEnvFile(startDir?: string): Env;
export {};
