import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TopicCluster } from "../src/brain.js";
import { createClusterSummarizer } from "../src/compression.js";
import { loadPeonConfig, type PeonConfig } from "../src/config.js";
import { createGlobalExtractor } from "../src/global-extraction.js";
import { PeonMemoryStore } from "../src/memory-store.js";
import { withModelSlot } from "../src/model-slots.js";
import { PeonMemoryProcessor, resetConsolidationScheduling, type MemoryModelClient } from "../src/processor.js";
import { createRecurator } from "../src/recuration.js";

/**
 * One queue for every background model call. Measured on a local model server: while a
 * consolidation ran, global extraction (98 facts), brain compression and embeddings all hit
 * the same server outside the consolidation slot. Two 4-minute generations ran side by side
 * (4m07s and 4m20s, just under Node's 300 s header limit), and a second project's
 * consolidation sat 25+ minutes with its requests unanswered in the server's queue.
 */

beforeEach(() => resetConsolidationScheduling());
afterEach(() => vi.unstubAllGlobals());

function localConfig(): PeonConfig {
  return loadPeonConfig({
    PEON_PROVIDER: "ollama",
    PEON_LLM_BASE_URL: "http://model-server.test:11434/v1",
    PEON_PROCESSING_MODEL: "qwen2.5:7b-ctx32k",
    PEON_EMBEDDING_MODE: "local",
    PEON_AI_MODE: "gated",
    PEON_FLUSH_MIN_CHARS: "200"
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
};

/** A chat-completions stub that records each request's system prompt and init. */
function recordingServer() {
  const calls: Array<{ system: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages?: Array<{ role: string; content: string }> };
    calls.push({ system: body.messages?.find((m) => m.role === "system")?.content ?? "", init });
    return new Response(JSON.stringify({ choices: [{ message: { content: '["a summary"]' } }] }));
  });
  return calls;
}

const cluster = { entity: "home server", members: [{ content: "M1 serves models." }, { content: "M1 is on Tailscale." }] } as unknown as TopicCluster;

describe("withModelSlot", () => {
  test("a local provider runs one model call at a time, releasing between calls", async () => {
    let active = 0;
    let maxActive = 0;
    const call = () =>
      withModelSlot(localConfig(), async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await settle();
        active -= 1;
      });
    await Promise.all([call(), call(), call()]);
    expect(maxActive).toBe(1);
  });
});

describe("background model calls share the consolidation's slot", () => {
  test("brain compression waits while a consolidation's model call holds the local model", async () => {
    const calls = recordingServer();
    const projectPath = await mkdtemp(join(tmpdir(), "peon-slot-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "slot-test", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "Decision: one queue for the local model. ".repeat(12) });

    let release: () => void = () => {};
    let modelCalls = 0;
    const heldModel: MemoryModelClient = {
      async processMemory() {
        modelCalls += 1;
        await new Promise<void>((r) => (release = r));
        return { content: JSON.stringify({ summary: "ok", decisions: ["d"] }), model: "held", estimatedTokens: 1 };
      }
    };
    const run = new PeonMemoryProcessor({ config: localConfig(), modelClient: heldModel }).processMemory({ projectPath, reason: "t" });
    await until(() => modelCalls === 1);

    const summary = createClusterSummarizer(localConfig())!(cluster);
    await settle();
    expect(calls.filter((c) => /compress/i.test(c.system))).toHaveLength(0); // queued behind the consolidation

    release();
    await run;
    await summary;
    expect(calls.filter((c) => /compress/i.test(c.system))).toHaveLength(1);
  });

  test("background calls carry an explicit deadline", async () => {
    const calls = recordingServer();
    await createClusterSummarizer(localConfig())!(cluster);
    await createGlobalExtractor(localConfig())?.([{ id: "1", type: "fact", content: "The user runs Ollama on an M1." }] as never).catch(() => undefined);
    await createRecurator(localConfig())?.([] as never, "q" as never).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });
});
