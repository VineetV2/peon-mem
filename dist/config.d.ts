export interface PeonConfig {
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
