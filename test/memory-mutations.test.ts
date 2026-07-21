import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyDelete, applyMerge, applyPin, applyUpdate } from "../src/memory-mutations.js";
import { PeonMemoryProcessor } from "../src/processor.js";
import { createPeonTools } from "../src/tools.js";
import type { MemoryRecord, ProcessedMemory } from "../src/types.js";

const NOW = "2026-06-14T00:00:00.000Z";
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
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "r", type: "decision", content: "c", normalized: "c", scope: "project", status: "active",
    score: { importance: 0.5, confidence: 0.5 }, source: { kind: "ai_processing" }, entities: [],
    createdAt: NOW, updatedAt: NOW, ...over
  };
}

describe("pure memory mutations", () => {
  test("applyUpdate edits content, clamps scores, bumps updatedAt", () => {
    const out = applyUpdate([rec({ id: "a" })], "a", { content: "  new text  ", importance: 1.5 }, "2026-06-15T00:00:00.000Z");
    expect(out[0].content).toBe("new text");
    expect(out[0].score.importance).toBe(1); // clamped
    expect(out[0].updatedAt).toBe("2026-06-15T00:00:00.000Z");
  });
  test("applyUpdate on unknown id leaves the set unchanged", () => {
    const input = [rec({ id: "a" })];
    expect(applyUpdate(input, "zzz", { content: "x" }, NOW)).toEqual(input);
  });
  test("applyDelete removes only the target", () => {
    const out = applyDelete([rec({ id: "a" }), rec({ id: "b" })], "a");
    expect(out.map((r) => r.id)).toEqual(["b"]);
  });
  test("applyPin toggles the pinned flag", () => {
    expect(applyPin([rec({ id: "a" })], "a", true, NOW)[0].pinned).toBe(true);
  });
  test("applyMerge unions entities, takes max scores, ORs pin, drops the merged record", () => {
    const records = [
      rec({ id: "keep", entities: ["x"], score: { importance: 0.4, confidence: 0.9 }, pinned: false }),
      rec({ id: "drop", entities: ["y"], score: { importance: 0.8, confidence: 0.2 }, pinned: true })
    ];
    const out = applyMerge(records, "keep", "drop", NOW);
    expect(out.map((r) => r.id)).toEqual(["keep"]);
    expect(out[0].entities.sort()).toEqual(["x", "y"]);
    expect(out[0].score).toEqual({ importance: 0.8, confidence: 0.9 });
    expect(out[0].pinned).toBe(true);
  });
  test("applyMerge with an unknown id makes no partial change", () => {
    const input = [rec({ id: "keep" })];
    expect(applyMerge(input, "keep", "missing", NOW)).toEqual(input);
  });
});

describe("store-backed mutations via tools", () => {
  async function seed() {
    const project = tempDir("peon-mut-proj-");
    const stateDir = tempDir("peon-mut-state-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    await new PeonMemoryProcessor().processMemory({
      projectPath: project,
      reason: "seed",
      aiResult: processed({ decisions: ["Use PostgreSQL for storage.", "Deploy on Fridays."] })
    });
    const tools2 = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    return { project, tools: tools2 };
  }

  test("edit then re-read shows the change persisted", async () => {
    const { project, tools } = await seed();
    const before = (await tools.searchMemory({ projectPath: project, query: "postgres" })).records;
    const id = before[0].record.id;
    const updated = await tools.updateMemory({ projectPath: project, id, content: "Use SQLite for storage.", pinned: true });
    expect(updated?.content).toBe("Use SQLite for storage.");
    expect(updated?.pinned).toBe(true);
    const reread = (await tools.searchMemory({ projectPath: project, query: "sqlite storage" })).records;
    expect(reread.some((r) => r.record.content === "Use SQLite for storage." && r.record.pinned)).toBe(true);
  });

  test("delete removes the belief from the project brain", async () => {
    const { project, tools } = await seed();
    const records = (await tools.searchMemory({ projectPath: project, query: "deploy fridays" })).records;
    const id = records.find((r) => r.record.content.includes("Friday"))!.record.id;
    expect(await tools.deleteMemory({ projectPath: project, id })).toEqual({ deleted: true });
    const after = (await tools.searchMemory({ projectPath: project, query: "deploy fridays" })).records;
    expect(after.some((r) => r.record.content.includes("Friday"))).toBe(false);
  });

  test("delete of an unknown id reports deleted:false", async () => {
    const { project, tools } = await seed();
    expect(await tools.deleteMemory({ projectPath: project, id: "nope" })).toEqual({ deleted: false });
  });
});
