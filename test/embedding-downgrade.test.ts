import { describe, expect, test, vi } from "vitest";
import { createEmbeddingClient, resolveEmbeddingPlan } from "../src/embeddings.js";
import type { PeonConfig } from "../src/config.js";

/**
 * Peon degrades to deterministic local trigram embeddings whenever the configured
 * embedder is unavailable. That is the right behaviour — but it was completely
 * silent. Two real incidents:
 *
 *   1. PEON_EMBEDDING_MODE=ollama with the server briefly down: 30k+ records were
 *      embedded with trigram vectors and (before 1.0.7) persisted as if real.
 *   2. A script run from a directory where the .env was not found: mode resolved to
 *      "local" and every vector silently became trigram — no warning at all.
 *
 * Retrieval quality collapses and nothing says so. A downgrade must be loud.
 */

function cfg(over: Partial<PeonConfig> = {}): PeonConfig {
  return {
    provider: "openrouter",
    llmApiKey: undefined,
    llmBaseUrl: "https://openrouter.ai/api/v1",
    openRouterApiKey: undefined,
    processingModel: "google/gemini-2.5-flash-lite",
    embeddingMode: "local",
    embeddingModel: undefined,
    memoryDirName: ".peon",
    flushMinChars: 6000,
    aiMode: "gated",
    ...over
  } as PeonConfig;
}

describe("embedding downgrades are visible", () => {
  test("asking for api without credentials is reported as a downgrade", () => {
    const plan = resolveEmbeddingPlan(cfg({ embeddingMode: "api", embeddingModel: "openai/text-embedding-3-small" }));
    expect(plan.intended).toBe("api");
    expect(plan.effective).toBe("local");
    expect(plan.downgraded).toBe(true);
    expect(plan.reason).toMatch(/credential|key/i);
  });

  test("a fully configured api setup is not a downgrade", () => {
    const plan = resolveEmbeddingPlan(cfg({
      embeddingMode: "api",
      embeddingModel: "openai/text-embedding-3-small",
      openRouterApiKey: "sk-test"
    }));
    expect(plan.downgraded).toBe(false);
    expect(plan.effective).toBe("api");
  });

  test("ollama is taken at face value — reachability is a runtime concern", () => {
    const plan = resolveEmbeddingPlan(cfg({ embeddingMode: "ollama", embeddingModel: "qwen3-embedding:0.6b" }));
    expect(plan.effective).toBe("ollama");
    expect(plan.downgraded).toBe(false);
  });

  test("explicit local is a deliberate choice, not a downgrade", () => {
    const plan = resolveEmbeddingPlan(cfg({ embeddingMode: "local" }));
    expect(plan.downgraded).toBe(false);
  });

  test("creating a downgraded client warns exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = cfg({ embeddingMode: "api", embeddingModel: "openai/text-embedding-3-small" });
    createEmbeddingClient({ config });
    createEmbeddingClient({ config });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => /embedding/i.test(m))).toHaveLength(1);
    expect(messages[0]).toMatch(/local/i);
    warn.mockRestore();
  });
});
