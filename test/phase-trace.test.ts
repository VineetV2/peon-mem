import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPeonConfig } from "../src/config.js";
import { PeonMemoryStore } from "../src/memory-store.js";
import { PeonMemoryProcessor, resetConsolidationScheduling, setPhaseTraceTimings, type MemoryModelClient } from "../src/processor.js";

beforeEach(() => {
  resetConsolidationScheduling();
  setPhaseTraceTimings(30, 40);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
});
afterEach(() => {
  setPhaseTraceTimings(10_000, 120_000);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a stalled consolidation names the phase it is stuck in, then reports how long it took", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const projectPath = await mkdtemp(join(tmpdir(), "peon-trace-"));
  const store = await PeonMemoryStore.open({ projectPath });
  const session = await store.startSession({ client: "trace-test", cwd: projectPath });
  await store.recordMessage({ sessionId: session.id, role: "user", content: "Decision: trace every phase. ".repeat(12) });

  const slowModel: MemoryModelClient = {
    async processMemory() {
      await new Promise((r) => setTimeout(r, 150));
      return { content: JSON.stringify({ summary: "ok", decisions: ["d"] }), model: "slow", estimatedTokens: 1 };
    }
  };
  const config = loadPeonConfig({ PEON_PROVIDER: "ollama", PEON_LLM_BASE_URL: "http://m.test:11434/v1", PEON_EMBEDDING_MODE: "local" });
  await new PeonMemoryProcessor({ config, modelClient: slowModel }).processMemory({ projectPath, reason: "t" });

  const lines = warn.mock.calls.map((c) => String(c[0]));
  expect(lines.some((l) => /still in "model call/.test(l))).toBe(true);
  expect(lines.some((l) => /"model call[^"]*" took/.test(l))).toBe(true);
});
