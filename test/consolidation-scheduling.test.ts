import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import {
  OpenRouterMemoryModelClient,
  PeonMemoryProcessor,
  resetConsolidationScheduling,
  type MemoryModelClient
} from "../src/processor.js";
import { loadPeonConfig, type PeonConfig } from "../src/config.js";

/**
 * With a local model, one consolidation takes minutes. The model call runs outside
 * store.runExclusive, so every hook trigger (session_end, turn_end, subagent_end) used to
 * start its own run on the SAME unconsumed chunk, and several projects' backlogs queued
 * inside one Ollama server, where requests waiting past Node fetch's 300 s header timeout
 * failed. Observed live: four overlapping runs of one project, 5 "fetch failed" in 20 min.
 */

beforeEach(() => {
  resetConsolidationScheduling();
  // Entity extraction calls the model server whenever a provider is enabled; keep it offline.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
});
afterEach(() => vi.unstubAllGlobals());

function config(overrides: Partial<PeonConfig> = {}): PeonConfig {
  return {
    ...loadPeonConfig({
      PEON_PROVIDER: "ollama",
      PEON_LLM_BASE_URL: "http://model-server.test:11434/v1",
      PEON_PROCESSING_MODEL: "qwen2.5:7b-ctx32k",
      PEON_EMBEDDING_MODE: "local",
      PEON_AI_MODE: "gated",
      PEON_FLUSH_MIN_CHARS: "200"
    }),
    ...overrides
  };
}

async function seededProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "peon-sched-"));
  const store = await PeonMemoryStore.open({ projectPath });
  const session = await store.startSession({ client: "sched-test", cwd: projectPath });
  await store.recordMessage({
    sessionId: session.id,
    role: "user",
    content: "Decision: consolidation runs on the local model, one run per project at a time. ".repeat(8)
  });
  return projectPath;
}

/** A model that holds every call open until released, and records how many overlap. */
function heldModel(options: { failFirst?: boolean } = {}) {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const pending: Array<() => void> = [];
  const client: MemoryModelClient = {
    async processMemory() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const call = calls;
      await new Promise<void>((release) => pending.push(release));
      active -= 1;
      if (options.failFirst && call === 1) throw new Error("model server went away");
      return {
        content: JSON.stringify({ summary: "ok", decisions: [`decision from call ${call}`] }),
        model: "held-model",
        estimatedTokens: 1
      };
    }
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 5));
  };
  return {
    client,
    calls: () => calls,
    active: () => active,
    maxActive: () => maxActive,
    waitForCalls: (n: number) => until(() => calls >= n),
    releaseAll: () => pending.splice(0).forEach((release) => release())
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("one consolidation per project", () => {
  test("a trigger that arrives while a run is in flight is skipped as in_progress", async () => {
    const projectPath = await seededProject();
    const model = heldModel();
    const processor = () => new PeonMemoryProcessor({ config: config(), modelClient: model.client });

    const first = processor().maybeProcessMemory({ projectPath, trigger: "session_end" });
    await model.waitForCalls(1);
    const second = await processor().maybeProcessMemory({ projectPath, trigger: "turn_end" });

    expect(second).toMatchObject({ status: "skipped", decision: { action: "skip", reason: "in_progress" } });
    model.releaseAll();
    expect((await first).status).toBe("processed");
    expect(model.calls()).toBe(1);
  });

  test("triggers fired in the same tick start exactly one run", async () => {
    const projectPath = await seededProject();
    const model = heldModel();
    const run = (trigger: string) =>
      new PeonMemoryProcessor({ config: config(), modelClient: model.client }).maybeProcessMemory({ projectPath, trigger });

    const results = Promise.all([run("session_end"), run("turn_end"), run("subagent_end")]);
    await model.waitForCalls(1);
    await settle();
    model.releaseAll();

    const statuses = (await results).map((r) => (r.status === "skipped" ? r.decision.reason : r.status)).sort();
    expect(statuses).toEqual(["in_progress", "in_progress", "processed"]);
    expect(model.calls()).toBe(1);
  });

  test("an in_progress skip does not write processing-state (it would race the run's cursor)", async () => {
    const projectPath = await seededProject();
    const model = heldModel();
    const first = new PeonMemoryProcessor({ config: config(), modelClient: model.client }).maybeProcessMemory({
      projectPath,
      trigger: "session_end"
    });
    await model.waitForCalls(1);
    await new PeonMemoryProcessor({ config: config(), modelClient: model.client }).maybeProcessMemory({
      projectPath,
      trigger: "turn_end"
    });

    const state = await (await PeonMemoryStore.open({ projectPath })).readProcessingState();
    expect(state.lastSkipReason).not.toBe("in_progress");
    model.releaseAll();
    await first;
  });

  test("a failed run clears the in-flight state, so the next trigger runs", async () => {
    const projectPath = await seededProject();
    const model = heldModel({ failFirst: true });
    const processor = () => new PeonMemoryProcessor({ config: config(), modelClient: model.client });

    const first = processor().maybeProcessMemory({ projectPath, trigger: "session_end" });
    await model.waitForCalls(1);
    model.releaseAll();
    await expect(first).rejects.toThrow(/went away/);

    const retry = processor().maybeProcessMemory({ projectPath, trigger: "turn_end" });
    await model.waitForCalls(2);
    model.releaseAll();
    expect((await retry).status).toBe("processed");
  });

  test("an explicit process_memory waits for the run in flight, then takes the next chunk", async () => {
    const projectPath = await seededProject();
    const model = heldModel();
    const processor = () => new PeonMemoryProcessor({ config: config(), modelClient: model.client });

    const auto = processor().maybeProcessMemory({ projectPath, trigger: "session_end" });
    await model.waitForCalls(1);
    const manual = processor().processMemory({ projectPath, reason: "manual" });
    await settle();
    expect(model.calls()).toBe(1); // still waiting, not overlapping

    model.releaseAll();
    await auto;
    await model.waitForCalls(2);
    model.releaseAll();
    await manual;
    expect(model.maxActive()).toBe(1);
  });
});

describe("a global cap on concurrent consolidations", () => {
  test("defaults to one at a time for a local (ollama) provider, across projects", async () => {
    const [a, b] = await Promise.all([seededProject(), seededProject()]);
    const model = heldModel();
    const run = (projectPath: string) =>
      new PeonMemoryProcessor({ config: config(), modelClient: model.client }).maybeProcessMemory({
        projectPath,
        trigger: "session_end"
      });

    const both = Promise.all([run(a), run(b)]);
    await model.waitForCalls(1);
    await settle();
    expect(model.active()).toBe(1); // the second project waits for a slot instead of queueing in Ollama

    model.releaseAll();
    await model.waitForCalls(2);
    model.releaseAll();
    expect((await both).map((r) => r.status)).toEqual(["processed", "processed"]);
    expect(model.maxActive()).toBe(1);
  });

  test("PEON_CONSOLIDATION_CONCURRENCY raises the cap", async () => {
    const [a, b] = await Promise.all([seededProject(), seededProject()]);
    const model = heldModel();
    const run = (projectPath: string) =>
      new PeonMemoryProcessor({ config: config({ consolidationConcurrency: 2 }), modelClient: model.client }).maybeProcessMemory({
        projectPath,
        trigger: "session_end"
      });

    const both = Promise.all([run(a), run(b)]);
    await model.waitForCalls(2);
    expect(model.maxActive()).toBe(2);
    model.releaseAll();
    await both;
  });

  test("config reads PEON_CONSOLIDATION_CONCURRENCY and PEON_LLM_TIMEOUT_MS", () => {
    const loaded = loadPeonConfig({ PEON_CONSOLIDATION_CONCURRENCY: "3", PEON_LLM_TIMEOUT_MS: "120000" });
    expect(loaded.consolidationConcurrency).toBe(3);
    expect(loaded.llmTimeoutMs).toBe(120000);
    expect(loadPeonConfig({}).consolidationConcurrency).toBeUndefined(); // provider default applies
    expect(loadPeonConfig({}).llmTimeoutMs).toBe(600000);
  });
});

describe("the consolidation request has an explicit timeout", () => {
  test("a model server that never answers fails with a clear timeout, not a hang", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
    );
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: "some session log", config: config({ llmTimeoutMs: 50 }), reason: "test" })
    ).rejects.toThrow(/did not answer within 0\.05 s[\s\S]*PEON_LLM_TIMEOUT_MS[\s\S]*not consumed/i);
  });

  test("Node fetch's own 300 s header timeout is named, not reported as 'fetch failed'", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
    });
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: "some session log", config: config(), reason: "test" })
    ).rejects.toThrow(/300 s[\s\S]*not consumed/i);
  });

  test("an unreachable model server names the address", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    });
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: "some session log", config: config(), reason: "test" })
    ).rejects.toThrow(/model-server\.test:11434[\s\S]*ECONNREFUSED/);
  });
});
