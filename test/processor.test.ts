import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import { PeonMemoryProcessor, parseProcessedMemory, type MemoryModelClient } from "../src/processor.js";

describe("parseProcessedMemory (robust against model output)", () => {
  test("strips a ```json fence with surrounding prose (was a 500 on session-end)", () => {
    const raw = 'Here is the memory:\n```json\n{"summary":"s","decisions":["d1"]}\n```\nDone.';
    const p = parseProcessedMemory(raw);
    expect(p.summary).toBe("s");
    expect(p.decisions).toEqual(["d1"]);
  });
  test("picks the real answer when an EXAMPLE fence precedes it (not the first fence)", () => {
    const raw = 'Example:\n```json\n{"summary":"EXAMPLE","decisions":["ignore"]}\n```\nAnswer:\n```json\n{"summary":"real","decisions":["keep"]}\n```';
    const p = parseProcessedMemory(raw);
    expect(p.summary).toBe("real");
    expect(p.decisions).toEqual(["keep"]);
  });
  test("strips a '''json fence (some models emit triple single-quotes, not backticks)", () => {
    // Observed in the wild on session-end: "Unexpected token ''', \"'''json\\n{\\n\"... is not valid JSON".
    const raw = "'''json\n{\"summary\":\"q\",\"decisions\":[\"d1\"]}\n'''";
    const p = parseProcessedMemory(raw);
    expect(p.summary).toBe("q");
    expect(p.decisions).toEqual(["d1"]);
  });
  test("picks the real answer past an EXAMPLE block when both use '''json fences", () => {
    // The brace-slice fallback would span both objects and fail; fence detection must handle ''' too.
    const raw = "Example:\n'''json\n{\"summary\":\"EXAMPLE\",\"decisions\":[\"ignore\"]}\n'''\nAnswer:\n'''json\n{\"summary\":\"real\",\"decisions\":[\"keep\"]}\n'''";
    const p = parseProcessedMemory(raw);
    expect(p.summary).toBe("real");
    expect(p.decisions).toEqual(["keep"]);
  });
  test("does not break on backticks inside a JSON string value", () => {
    const raw = '{"summary":"run ```bash\\nls``` first","decisions":[]}';
    const p = parseProcessedMemory(raw);
    expect(p.summary).toContain("```bash");
  });
  test("throws on genuinely-unparseable output so the delta cursor is preserved (retry, not silent loss)", () => {
    // The daemon boundary (runAutomaticProcessing) absorbs this into an auto_process_fail + 200;
    // parseProcessedMemory itself must surface it, never advance the cursor.
    expect(() => parseProcessedMemory("```json\n{ totally broken")).toThrow();
    expect(() => parseProcessedMemory("not json at all")).toThrow();
  });
});

describe("PeonMemoryProcessor", () => {
  test("uses a model response to update structured brain files", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-processor-test-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "processor-test", cwd: projectPath });
    await store.recordMessage({
      sessionId: session.id,
      role: "user",
      content: "We decided to keep AI processing gated to control API cost."
    });
    await store.endSession({ sessionId: session.id });

    const modelClient: MemoryModelClient = {
      async processMemory() {
        return {
          content: JSON.stringify({
            summary: "Peon records raw memory first and processes it only behind a cost gate.",
            decisions: ["Use gated AI processing for Peon memory."],
            preferences: ["Keep API calls low-cost."],
            openQuestions: ["Should automatic processing happen on session end?"],
            artifacts: ["peon-mcp/src/processor.ts"],
            timeline: ["Added AI processor design."]
          }),
          model: "test-model",
          estimatedTokens: 42
        };
      }
    };

    const processor = new PeonMemoryProcessor({ modelClient });
    const result = await processor.processMemory({ projectPath, reason: "manual-test" });

    expect(result.status).toBe("processed");
    expect(result.model).toBe("test-model");
    expect(result.estimatedTokens).toBe(42);
    expect(await readFile(join(projectPath, ".peon/brain/project-summary.md"), "utf8")).toContain(
      "Peon records raw memory first"
    );
    expect(await readFile(join(projectPath, ".peon/brain/decisions.md"), "utf8")).toContain(
      "Use gated AI processing"
    );
    expect(await readFile(join(projectPath, ".peon/brain/artifacts.md"), "utf8")).toContain(
      "peon-mcp/src/processor.ts"
    );

    const memories = await readJsonl(join(projectPath, ".peon/brain/memories.jsonl"));
    expect(memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "decision",
          content: "Use gated AI processing for Peon memory.",
          scope: "project",
          status: "active",
          source: expect.objectContaining({ kind: "ai_processing", reason: "manual-test" }),
          score: expect.objectContaining({
            importance: expect.any(Number),
            confidence: expect.any(Number)
          })
        }),
        expect.objectContaining({
          type: "artifact",
          content: "peon-mcp/src/processor.ts"
        })
      ])
    );

    const graph = JSON.parse(await readFile(join(projectPath, ".peon/brain/graph.json"), "utf8"));
    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "project", label: expect.stringContaining("peon-processor-test") }),
        expect.objectContaining({ type: "decision", label: "Use gated AI processing for Peon memory." }),
        expect.objectContaining({ type: "artifact", label: "peon-mcp/src/processor.ts" })
      ])
    );
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "contains" }),
        expect.objectContaining({ type: "produced" })
      ])
    );

    const context = await store.getContext({ query: "API cost gated processor", maxChars: 8000 });
    expect(context.memories).toContain("Structured Memory");
    expect(context.memories).toContain("Use gated AI processing for Peon memory.");
    expect(context.memories).toContain("importance=");
  });

  test("deduplicates structured memories across repeated processing", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-processor-dedupe-test-"));
    await PeonMemoryStore.open({ projectPath });
    const processor = new PeonMemoryProcessor();
    const aiResult = {
      summary: "The project uses a local-first Peon memory brain.",
      decisions: ["Use local-first memory storage."],
      preferences: ["Keep API calls gated."],
      openQuestions: [],
      artifacts: ["index.html"],
      timeline: ["Created initial project."]
    };

    await processor.processMemory({ projectPath, reason: "first-pass", aiResult });
    await processor.processMemory({ projectPath, reason: "second-pass", aiResult });

    const memories = await readJsonl(join(projectPath, ".peon/brain/memories.jsonl"));
    const decisions = memories.filter((memory) => memory.type === "decision" && memory.content === "Use local-first memory storage.");

    expect(decisions).toHaveLength(1);
  });

  test("extracts JSON even when the model wraps it in a markdown code fence", async () => {
    const modelClient: MemoryModelClient = {
      async processMemory() {
        return {
          content: '```json\n{"summary":"ok","decisions":[],"preferences":[],"openQuestions":[],"artifacts":[],"timeline":[]}\n```',
          model: "test-model",
          estimatedTokens: 5
        };
      }
    };

    const processor = new PeonMemoryProcessor({ modelClient });
    const projectPath = await mkdtemp(join(tmpdir(), "peon-processor-json-test-"));
    await PeonMemoryStore.open({ projectPath });

    await expect(processor.processMemory({ projectPath, reason: "json-test" })).resolves.toMatchObject({
      status: "processed"
    });
  });

  test("skips automatic processing when new memory is below the cost gate threshold", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-auto-skip-test-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "auto-test", cwd: projectPath });
    await store.recordMessage({
      sessionId: session.id,
      role: "user",
      content: "Small note."
    });
    await store.endSession({ sessionId: session.id });

    let calls = 0;
    const modelClient: MemoryModelClient = {
      async processMemory() {
        calls += 1;
        throw new Error("model should not be called");
      }
    };
    const processor = new PeonMemoryProcessor({
      config: {
        processingModel: "test-model",
        memoryDirName: ".peon",
        flushMinChars: 1000,
        aiMode: "gated",
        openRouterApiKey: "test-key"
      },
      modelClient
    });

    const result = await processor.maybeProcessMemory({ projectPath, trigger: "session_end" });

    expect(result.status).toBe("skipped");
    expect(result.decision.reason).toBe("below_threshold");
    expect(result.decision.trigger).toBe("session_end");
    expect(result.decision.rawChars).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  test("automatically processes when raw memory crosses the cost gate threshold and records state", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-auto-process-test-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "auto-test", cwd: projectPath });
    await store.recordMessage({
      sessionId: session.id,
      role: "user",
      content: "Decision: automatic processing should run when there is enough new raw memory. ".repeat(8)
    });
    await store.endSession({ sessionId: session.id });

    let calls = 0;
    const modelClient: MemoryModelClient = {
      async processMemory() {
        calls += 1;
        return {
          content: JSON.stringify({
            summary: "Automatic processing crossed the cost gate.",
            decisions: ["Run automatic processing only after enough new memory accumulates."],
            preferences: [],
            openQuestions: [],
            artifacts: [],
            timeline: ["Automatic processing ran."]
          }),
          model: "test-model",
          estimatedTokens: 123
        };
      }
    };
    const processor = new PeonMemoryProcessor({
      config: {
        processingModel: "test-model",
        memoryDirName: ".peon",
        flushMinChars: 200,
        aiMode: "gated",
        openRouterApiKey: "test-key"
      },
      modelClient
    });

    const processed = await processor.maybeProcessMemory({ projectPath, trigger: "session_end" });
    const skipped = await processor.maybeProcessMemory({ projectPath, trigger: "session_end" });

    expect(processed).toMatchObject({
      status: "processed",
      decision: expect.objectContaining({
        action: "process",
        reason: "threshold_reached",
        trigger: "session_end"
      }),
      result: expect.objectContaining({
        model: "test-model",
        estimatedTokens: 123
      })
    });
    expect(skipped).toMatchObject({
      status: "skipped",
      decision: expect.objectContaining({
        reason: "below_threshold"
      })
    });
    expect(calls).toBe(1);

    const state = JSON.parse(await readFile(join(projectPath, ".peon/brain/processing-state.json"), "utf8"));
    expect(state).toEqual(
      expect.objectContaining({
        lastStatus: "processed",
        lastTrigger: "session_end",
        lastModel: "test-model",
        lastEstimatedTokens: 123
      })
    );
  });

  test("applies quality signals after processing so conflicting memories are not injected as active", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-quality-apply-test-"));
    await PeonMemoryStore.open({ projectPath });
    const processor = new PeonMemoryProcessor();

    await processor.processMemory({
      projectPath,
      reason: "quality-apply-test",
      aiResult: {
        summary: "Quality processing test.",
        decisions: [],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: [],
        memories: [
          {
            type: "decision",
            content: "Docker is enabled for tests.",
            scope: "project",
            entities: ["Docker"]
          },
          {
            type: "decision",
            content: "Docker is disabled for tests.",
            scope: "project",
            entities: ["Docker"]
          }
        ]
      }
    });

    const memories = await readJsonl(join(projectPath, ".peon/brain/memories.jsonl"));
    expect(memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Docker is enabled for tests.", status: "conflicted" }),
        expect.objectContaining({ content: "Docker is disabled for tests.", status: "conflicted" })
      ])
    );

    const quality = JSON.parse(await readFile(join(projectPath, ".peon/brain/quality-report.json"), "utf8"));
    expect(quality.conflicts).toEqual([
      expect.objectContaining({
        // canonicalized entity key (domain concepts lowercase so "Docker"/"docker" dedupe)
        entity: "docker",
        reason: "opposing enabled/disabled language"
      })
    ]);
  });

  test("getContext hoists the top query-relevant belief into a headline banner (none without a query)", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-headline-"));
    await PeonMemoryStore.open({ projectPath });
    const processor = new PeonMemoryProcessor();
    await processor.processMemory({
      projectPath,
      reason: "headline-test",
      aiResult: {
        summary: "",
        decisions: ["Submit Exp42 on the cluster with submit_v2.sh + run_v2.slurm (sqlvllm env)."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: []
      }
    });
    const store = await PeonMemoryStore.open({ projectPath });
    const withQuery = await store.getContext({ query: "how do I submit Exp42 on the cluster", maxChars: 8000 });
    expect(withQuery.headline).toBeDefined();
    expect(withQuery.headline).toContain("submit_v2.sh");
    // no query → no "most relevant" headline (it would be meaningless)
    const noQuery = await store.getContext({ maxChars: 8000 });
    expect(noQuery.headline).toBeUndefined();
    // a query that does NOT genuinely match → no banner (don't parade an irrelevant belief as
    // "most relevant" just because it exists / was recent).
    const unrelated = await store.getContext({ query: "quarterly budget spreadsheet color palette", maxChars: 8000 });
    expect(unrelated.headline).toBeUndefined();
  });
});

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
