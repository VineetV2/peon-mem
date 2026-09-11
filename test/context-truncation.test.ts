import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import { OpenRouterMemoryModelClient, PeonMemoryProcessor, detectPromptTruncation } from "../src/processor.js";
import { loadPeonConfig } from "../src/config.js";

/**
 * Ollama's default context window is 4096 tokens. Peon's consolidation prompt runs
 * ~22K. Ollama does not error — it silently keeps only the LAST 4096 tokens, which
 * throws away the system prompt and JSON schema. The model then returns `{}` and the
 * session is marked consumed with nothing learned. Measured on a real brain: three
 * consolidations in a row produced zero records this way, with no error anywhere.
 *
 * OpenAI-compatible servers report usage.prompt_tokens — what the model actually
 * processed. When that is far below what Peon sent, the prompt was truncated.
 */

afterEach(() => vi.unstubAllGlobals());

function ollamaConfig() {
  return loadPeonConfig({
    PEON_PROVIDER: "ollama",
    PEON_LLM_BASE_URL: "http://model-server.test:11434/v1",
    PEON_PROCESSING_MODEL: "qwen2.5:7b",
    PEON_EMBEDDING_MODE: "local",
    PEON_AI_MODE: "gated"
  });
}

/** A chat-completions response whose usage says how much of the prompt was processed. */
function stubModelServer(promptTokens: number | undefined, content = '{"summary":"ok","decisions":[]}') {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        ...(promptTokens === undefined ? {} : { usage: { prompt_tokens: promptTokens, completion_tokens: 12 } })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LONG_LOG = "The daemon wedged on a quadratic conflict scan and was fixed. ".repeat(1400); // ~87K chars

describe("detectPromptTruncation", () => {
  test("flags a prompt the server capped at its window", () => {
    // measured: 4096 reported vs ~17,334 estimated (ratio 0.24)
    expect(detectPromptTruncation(17334, 4096)).toBe(true);
  });

  test("does not flag a full prompt, even though chars/4 over-estimates English", () => {
    // measured on the same text with a 32K window: 12,625 vs 17,334 (ratio 0.73)
    expect(detectPromptTruncation(17334, 12625)).toBe(false);
  });

  test("cannot tell when the server reports no usage", () => {
    expect(detectPromptTruncation(17334, undefined)).toBe(false);
    expect(detectPromptTruncation(17334, 0)).toBe(false);
  });

  test("ignores small prompts where estimation noise dominates", () => {
    expect(detectPromptTruncation(900, 300)).toBe(false);
  });
});

describe("consolidation refuses a truncated prompt", () => {
  test("the model client throws an actionable error when the server truncated", async () => {
    stubModelServer(4096);
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" })
    ).rejects.toThrow(/truncated[\s\S]*context window[\s\S]*num_ctx/i);
  });

  test("a full, untruncated prompt is accepted", async () => {
    stubModelServer(20000);
    const client = new OpenRouterMemoryModelClient();
    const res = await client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" });
    expect(res.content).toContain("summary");
  });

  test("a server that reports no usage is not blocked", async () => {
    stubModelServer(undefined);
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" })
    ).resolves.toBeDefined();
  });

  test("the session log is NOT consumed, so it is consolidated properly once fixed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-truncation-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "test", cwd: projectPath });
    // Realistic session: many moderate turns, each well under the 60K delta cap, so the
    // first consolidation round genuinely carries a large prompt. (One giant message
    // would be deferred to a second round behind the small session_started event.)
    const turn = "We found the daemon wedging on a quadratic conflict scan and fixed it. ".repeat(55);
    for (let i = 0; i < 12; i += 1) {
      await store.recordMessage({ sessionId: session.id, role: i % 2 ? "assistant" : "user", content: `${i}: ${turn}` });
    }

    const before = (await store.readProcessingState()).lastProcessedEventId;
    stubModelServer(4096);
    const processor = new PeonMemoryProcessor({ config: ollamaConfig() });

    await expect(processor.processMemory({ projectPath, reason: "test" })).rejects.toThrow(/truncated/i);

    // The cursor must not move past data that was never actually consolidated.
    const after = (await (await PeonMemoryStore.open({ projectPath })).readProcessingState()).lastProcessedEventId;
    expect(after).toBe(before);
  });
});
