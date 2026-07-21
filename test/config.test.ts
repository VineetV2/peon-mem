import { describe, expect, it } from "vitest";
import { loadPeonConfig } from "../src/config.js";

describe("Peon MCP config", () => {
  it("uses a low-cost non-OpenAI model for memory processing by default", () => {
    const config = loadPeonConfig({});

    expect(config.processingModel).toBe("google/gemini-2.5-flash-lite");
    expect(config.embeddingModel).toBeUndefined();
    expect(config.memoryDirName).toBe(".peon");
  });

  it("defaults to local (offline) embeddings", () => {
    expect(loadPeonConfig({}).embeddingMode).toBe("local");
  });

  it("respects PEON_EMBEDDING_MODE override", () => {
    expect(loadPeonConfig({ PEON_EMBEDDING_MODE: "off" }).embeddingMode).toBe("off");
    expect(loadPeonConfig({ PEON_EMBEDDING_MODE: "api" }).embeddingMode).toBe("api");
    expect(loadPeonConfig({ PEON_EMBEDDING_MODE: "nonsense" }).embeddingMode).toBe("local");
  });
});

