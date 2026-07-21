import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PeonMemoryProcessor } from "../src/processor.js";
import { createPeonTools } from "../src/tools.js";
import { isGloballyPromotable, selectGloballyPromotable } from "../src/global-promotion.js";
import type { MemoryRecord, ProcessedMemory } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function processed(over: Partial<ProcessedMemory> = {}): ProcessedMemory {
  return { summary: "", decisions: [], preferences: [], openQuestions: [], artifacts: [], timeline: [], memories: [], operations: [], ...over };
}
function record(over: Partial<MemoryRecord>): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "r",
    type: "fact",
    content: "c",
    normalized: "c",
    scope: "project",
    status: "active",
    score: { importance: 0.8, confidence: 0.8 },
    source: { kind: "ai_processing" },
    entities: [],
    createdAt: now,
    updatedAt: now,
    ...over
  };
}

describe("global promotion policy (the pure predicate)", () => {
  test("promotes any record explicitly scoped global", () => {
    expect(isGloballyPromotable(record({ type: "decision", scope: "global" }))).toBe(true);
  });
  test("promotes fact records by default (environment/user knowledge is cross-cutting)", () => {
    expect(isGloballyPromotable(record({ type: "fact", scope: "project" }))).toBe(true);
  });
  test("leaves project-internal decisions and artifacts project-scoped", () => {
    expect(isGloballyPromotable(record({ type: "decision", scope: "project" }))).toBe(false);
    expect(isGloballyPromotable(record({ type: "artifact", scope: "project" }))).toBe(false);
    expect(isGloballyPromotable(record({ type: "preference", scope: "project" }))).toBe(false);
  });
  test("never promotes inactive records", () => {
    expect(isGloballyPromotable(record({ type: "fact", status: "superseded" }))).toBe(false);
    expect(isGloballyPromotable(record({ scope: "global", status: "stale" }))).toBe(false);
  });
  test("selects only the promotable subset", () => {
    const records = [
      record({ id: "a", type: "fact" }),
      record({ id: "b", type: "decision", scope: "project" }),
      record({ id: "c", type: "decision", scope: "global" })
    ];
    expect(selectGloballyPromotable(records).map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("promoteToGlobal (project beliefs lifted into global memory)", () => {
  test("copies fact + global-scoped beliefs into global, leaving project-only ones behind", async () => {
    const project = tempDir("peon-promote-proj-");
    const globalDir = tempDir("peon-promote-global-");
    const stateDir = tempDir("peon-promote-state-");
    const tools = createPeonTools({ globalMemoryDir: globalDir, sessionIndexPath: join(stateDir, "sessions-index.json") });
    const processor = new PeonMemoryProcessor();

    // A reusable environment fact (model flagged it via the `global` channel → scope global),
    // a plain fact, and a project-internal decision that must stay local.
    await processor.processMemory({
      projectPath: project,
      reason: "seed",
      aiResult: processed({
        decisions: ["This repo uses a private memory store."],
        memories: [
          { type: "fact", content: "NJIT Wulver login host is wulver.njit.edu.", scope: "global" },
          { type: "fact", content: "The user runs PyTorch jobs on 2x A100 GPUs." }
        ]
      })
    });

    const { promoted } = await tools.promoteToGlobal({ projectPath: project });
    const contents = promoted.map((r) => r.content).sort();

    expect(contents).toEqual([
      "NJIT Wulver login host is wulver.njit.edu.",
      "The user runs PyTorch jobs on 2x A100 GPUs."
    ]);
    // The project-internal decision was NOT promoted.
    expect(promoted.some((r) => r.content.includes("private memory store"))).toBe(false);

    // Everything promoted is now findable in the global store from any project.
    const globalHits = await tools.searchGlobalMemory({ query: "wulver njit gpu pytorch" });
    expect(globalHits.length).toBeGreaterThanOrEqual(2);
    expect(globalHits.every((r) => r.scope === "global")).toBe(true);
  });

  test("is idempotent — promoting twice does not duplicate global records", async () => {
    const project = tempDir("peon-promote2-proj-");
    const globalDir = tempDir("peon-promote2-global-");
    const stateDir = tempDir("peon-promote2-state-");
    const tools = createPeonTools({ globalMemoryDir: globalDir, sessionIndexPath: join(stateDir, "sessions-index.json") });
    const processor = new PeonMemoryProcessor();

    await processor.processMemory({
      projectPath: project,
      reason: "seed",
      aiResult: processed({ memories: [{ type: "fact", content: "The BIRD dev set has 1534 questions across 11 databases." }] })
    });

    await tools.promoteToGlobal({ projectPath: project });
    await tools.promoteToGlobal({ projectPath: project });

    const globalHits = await tools.searchGlobalMemory({ query: "bird dev set questions" });
    expect(globalHits).toHaveLength(1);
  });
});

describe("processor `global` channel", () => {
  test("parses the model's global[] array into scope-global fact records", async () => {
    const { parseProcessedMemory } = await import("../src/processor.js");
    const parsed = parseProcessedMemory(
      JSON.stringify({
        summary: "did stuff",
        decisions: ["repo-internal decision"],
        global: ["NJIT Wulver uses SLURM for job submission."]
      })
    );
    const globalRecord = (parsed.memories ?? []).find((m) => m.content.includes("SLURM"));
    expect(globalRecord).toMatchObject({ type: "fact", scope: "global" });
  });
});
