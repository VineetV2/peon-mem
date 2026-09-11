import { describe, expect, test } from "vitest";
import { llmEnabled, llmEndpoint, llmHeaders } from "../src/config.js";
import type { PeonConfig } from "../src/config.js";

/**
 * compression, global-extraction, entity-extraction and hyde each hardcoded
 * https://openrouter.ai/... and gated on config.openRouterApiKey. With
 * PEON_PROVIDER=ollama and no OpenRouter key they silently did nothing, so
 * "fully local" was not actually local. These helpers centralise the decision.
 */

function cfg(over: Partial<PeonConfig> = {}): PeonConfig {
  return {
    provider: "openrouter",
    llmApiKey: "sk-test",
    llmBaseUrl: "https://openrouter.ai/api/v1",
    openRouterApiKey: "sk-test",
    processingModel: "google/gemini-2.5-flash-lite",
    embeddingMode: "local",
    memoryDirName: ".peon",
    flushMinChars: 6000,
    aiMode: "gated",
    ...over
  } as PeonConfig;
}

describe("LLM endpoint resolution", () => {
  test("openrouter still routes to openrouter", () => {
    const c = cfg();
    expect(llmEnabled(c)).toBe(true);
    expect(llmEndpoint(c)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(llmHeaders(c).Authorization).toBe("Bearer sk-test");
  });

  test("ollama routes locally and needs no API key", () => {
    const c = cfg({
      provider: "ollama",
      llmBaseUrl: "http://127.0.0.1:11434/v1",
      llmApiKey: undefined,
      openRouterApiKey: undefined
    });
    // The bug: this used to be false, so local users got no entity extraction,
    // no HyDE and no compression at all.
    expect(llmEnabled(c)).toBe(true);
    expect(llmEndpoint(c)).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  test("a trailing slash on the base URL does not double up", () => {
    expect(llmEndpoint(cfg({ llmBaseUrl: "http://127.0.0.1:11434/v1/" })))
      .toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  test("aiMode off disables the LLM regardless of provider", () => {
    expect(llmEnabled(cfg({ aiMode: "off" }))).toBe(false);
    expect(llmEnabled(cfg({ provider: "ollama", aiMode: "off", llmApiKey: undefined }))).toBe(false);
  });

  test("a hosted provider without a key stays disabled", () => {
    expect(llmEnabled(cfg({ llmApiKey: undefined, openRouterApiKey: undefined }))).toBe(false);
  });
});
