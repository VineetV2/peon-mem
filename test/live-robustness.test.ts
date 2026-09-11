import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { embedQueryWithin, type EmbeddingClient } from "../src/embeddings.js";
import { PeonMemoryStore } from "../src/memory-store.js";
import {
  ModelTimeoutError,
  PeonMemoryProcessor,
  PromptTruncatedError,
  parseProcessedMemory,
  resetConsolidationScheduling,
  type MemoryModelClient
} from "../src/processor.js";
import { loadPeonConfig, type PeonConfig } from "../src/config.js";

// ── 1. A busy embedding server must not hold the prompt hostage ─────────────────────────
// Every prompt embeds its query. With the embedder on a small home server that is busy
// generating a consolidation, that embed took 26-40 s, so each prompt waited that long
// before Claude started. Failures already degraded to lexical retrieval; slowness did not.

const SLOW_QUERY = "what did we decide about the home server";

/** Embeds records instantly, but takes `queryDelayMs` to embed SLOW_QUERY (a busy server). */
function busyServerClient(queryDelayMs: number): EmbeddingClient {
  const vectorFor = (text: string) => [text.length % 7, 1, text.includes("server") ? 1 : 0];
  return {
    model: "busy-test",
    async embed(texts: string[]) {
      if (texts.length === 1 && texts[0] === SLOW_QUERY) {
        await new Promise((resolve) => setTimeout(resolve, queryDelayMs));
      }
      return texts.map(vectorFor);
    }
  };
}

describe("embedQueryWithin", () => {
  test("returns the vector when the server answers in time", async () => {
    await expect(embedQueryWithin(busyServerClient(0), SLOW_QUERY, 500)).resolves.toEqual([SLOW_QUERY.length % 7, 1, 1]);
  });

  test("gives up at the deadline instead of waiting for a busy server", async () => {
    const started = Date.now();
    await expect(embedQueryWithin(busyServerClient(5_000), SLOW_QUERY, 100)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a failing server means no vector, never a thrown error", async () => {
    const failing: EmbeddingClient = { model: "down", embed: async () => Promise.reject(new Error("ECONNREFUSED")) };
    await expect(embedQueryWithin(failing, "anything", 500)).resolves.toBeUndefined();
  });
});

describe("prompt-time retrieval with a busy embedding server", () => {
  test("answers lexically within the deadline instead of waiting on the server", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-busy-embed-"));
    const store = await PeonMemoryStore.open({
      projectPath,
      embeddingClient: busyServerClient(10_000),
      config: { ...loadPeonConfig({ PEON_EMBEDDING_MODE: "local" }), queryEmbedTimeoutMs: 150 }
    });
    await store.applyProcessedMemory(
      parseProcessedMemory(JSON.stringify({ summary: "s", decisions: ["The home server is the old M1 MacBook, serving models over Tailscale."] })),
      { reason: "seed" }
    );

    const started = Date.now();
    const ranked = await store.rankRecords(SLOW_QUERY);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ranked.some((r) => /home server/i.test(r.record.content))).toBe(true);
  });

  test("config reads PEON_QUERY_EMBED_TIMEOUT_MS (default 2 s)", () => {
    expect(loadPeonConfig({ PEON_QUERY_EMBED_TIMEOUT_MS: "750" }).queryEmbedTimeoutMs).toBe(750);
    expect(loadPeonConfig({}).queryEmbedTimeoutMs).toBe(2_000);
  });
});

// ── 2. Consolidation cannot get stuck on a chunk too big for the model setup ─────────────
// A chunk that times out (a slow local model) or overflows the model's context window was
// retried at the same size forever. Now it is halved for the next attempt, down to a floor,
// and grows back after successes.

beforeEach(() => {
  resetConsolidationScheduling();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
});
afterEach(() => vi.unstubAllGlobals());

function localConfig(): PeonConfig {
  return loadPeonConfig({
    PEON_PROVIDER: "ollama",
    PEON_LLM_BASE_URL: "http://model-server.test:11434/v1",
    PEON_PROCESSING_MODEL: "qwen2.5:7b-ctx32k",
    PEON_EMBEDDING_MODE: "local",
    PEON_AI_MODE: "gated"
  });
}

async function projectWithBacklog(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "peon-adaptive-"));
  const store = await PeonMemoryStore.open({ projectPath });
  const session = await store.startSession({ client: "adaptive-test", cwd: projectPath });
  const turn = "We moved consolidation to the local model and measured each chunk carefully. ".repeat(38); // ~3K
  for (let i = 0; i < 30; i += 1) {
    await store.recordMessage({ sessionId: session.id, role: i % 2 ? "assistant" : "user", content: `${i}: ${turn}` });
  }
  return projectPath;
}

/** Fails with `error` on the first call, then succeeds; records each delta size it was sent. */
function modelThatFirstFails(error: Error | undefined) {
  const deltaSizes: number[] = [];
  const client: MemoryModelClient = {
    async processMemory(input) {
      deltaSizes.push(input.rawMemory.length);
      if (error && deltaSizes.length === 1) throw error;
      return { content: JSON.stringify({ summary: "ok", decisions: ["d"] }), model: "stub", estimatedTokens: 1 };
    }
  };
  return { client, deltaSizes };
}

const stateOf = async (projectPath: string) => (await PeonMemoryStore.open({ projectPath })).readProcessingState();

describe("adaptive consolidation chunk size", () => {
  test("a timeout halves the next chunk, and the next attempt is sent the smaller chunk", async () => {
    const projectPath = await projectWithBacklog();
    const model = modelThatFirstFails(new ModelTimeoutError("did not answer within 600 s"));
    const processor = new PeonMemoryProcessor({ config: localConfig(), modelClient: model.client });

    await expect(processor.processMemory({ projectPath, reason: "t1" })).rejects.toThrow(/did not answer/);
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBe(30_000);

    await processor.processMemory({ projectPath, reason: "t2" });
    expect(model.deltaSizes[0]).toBeGreaterThan(30_000);
    expect(model.deltaSizes[1]).toBeLessThanOrEqual(30_000);
    expect(model.deltaSizes[1]).toBeGreaterThan(0);
  });

  test("a truncated prompt halves the next chunk too", async () => {
    const projectPath = await projectWithBacklog();
    const model = modelThatFirstFails(new PromptTruncatedError("processed 4096 tokens of roughly 18384 sent"));
    const processor = new PeonMemoryProcessor({ config: localConfig(), modelClient: model.client });

    await expect(processor.processMemory({ projectPath, reason: "t1" })).rejects.toThrow(/4096/);
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBe(30_000);
  });

  test("successes grow the chunk back toward the configured size, then clear the override", async () => {
    const projectPath = await projectWithBacklog();
    const store = await PeonMemoryStore.open({ projectPath });
    await store.writeProcessingState({ ...(await store.readProcessingState()), adaptiveMaxDeltaChars: 30_000 });
    const processor = new PeonMemoryProcessor({ config: localConfig(), modelClient: modelThatFirstFails(undefined).client });

    await processor.processMemory({ projectPath, reason: "grow1" });
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBe(37_500);

    await store.writeProcessingState({ ...(await store.readProcessingState()), adaptiveMaxDeltaChars: 55_000 });
    await processor.processMemory({ projectPath, reason: "grow2" });
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBeUndefined(); // back to the default
  });

  test("never shrinks below the floor", async () => {
    const projectPath = await projectWithBacklog();
    const store = await PeonMemoryStore.open({ projectPath });
    await store.writeProcessingState({ ...(await store.readProcessingState()), adaptiveMaxDeltaChars: 9_000 });
    const processor = new PeonMemoryProcessor({
      config: localConfig(),
      modelClient: modelThatFirstFails(new ModelTimeoutError("slow")).client
    });

    await expect(processor.processMemory({ projectPath, reason: "t" })).rejects.toThrow(/slow/);
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBe(8_000);
  });

  test("other failures (server unreachable) leave the chunk size alone", async () => {
    const projectPath = await projectWithBacklog();
    const processor = new PeonMemoryProcessor({
      config: localConfig(),
      modelClient: modelThatFirstFails(new Error("Could not reach the model server")).client
    });

    await expect(processor.processMemory({ projectPath, reason: "t" })).rejects.toThrow(/Could not reach/);
    expect((await stateOf(projectPath)).adaptiveMaxDeltaChars).toBeUndefined();
  });
});
