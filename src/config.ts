import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

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

function optional(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveEmbeddingMode(
  explicit: string | undefined,
  caps: { hasKey: boolean; hasModel: boolean }
): PeonConfig["embeddingMode"] {
  const normalized = explicit?.trim().toLowerCase();
  if (normalized === "off" || normalized === "api" || normalized === "local" || normalized === "ollama") return normalized;
  // No explicit mode: prefer REAL semantic embeddings when an API key + embedding
  // model are configured; otherwise fall back to the deterministic local lexical
  // (character-trigram) embeddings so retrieval still works fully offline.
  return caps.hasKey && caps.hasModel ? "api" : "local";
}

export function loadPeonConfig(env: Env = process.env): PeonConfig {
  const mergedEnv = env === process.env ? { ...readEnvFile(), ...env } : env;
  const openRouterApiKey = optional(mergedEnv.OPENROUTER_API_KEY);
  const embeddingModel = optional(mergedEnv.PEON_EMBEDDING_MODEL);
  return {
    openRouterApiKey,
    processingModel: mergedEnv.PEON_PROCESSING_MODEL ?? mergedEnv.PEON_SUMMARY_MODEL ?? "google/gemini-2.5-flash-lite",
    embeddingModel,
    embeddingMode: resolveEmbeddingMode(mergedEnv.PEON_EMBEDDING_MODE, {
      hasKey: Boolean(openRouterApiKey),
      hasModel: Boolean(embeddingModel)
    }),
    ollamaBaseUrl: optional(mergedEnv.PEON_OLLAMA_URL),
    memoryDirName: mergedEnv.PEON_MEMORY_DIR ?? ".peon",
    flushMinChars: numberFromEnv(mergedEnv.PEON_FLUSH_MIN_CHARS, 6000),
    aiMode: mergedEnv.PEON_AI_MODE === "off" ? "off" : "gated"
  };
}

export function readEnvFile(startDir: string = process.cwd()): Env {
  const envPath = findEnvFile(startDir);
  if (!envPath) return {};

  return Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const equalsIndex = line.indexOf("=");
        if (equalsIndex < 0) return undefined;
        const key = line.slice(0, equalsIndex).trim();
        const rawValue = line.slice(equalsIndex + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, "");
        return key ? ([key, value] as const) : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );
}

function findEnvFile(startDir: string): string | undefined {
  let current = startDir;
  const root = parse(current).root;

  while (true) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;
    if (current === root) return undefined;
    current = dirname(current);
  }
}
