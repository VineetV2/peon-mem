import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseIdArray } from "../src/recuration.js";
import { PeonMemoryProcessor } from "../src/processor.js";
import { createPeonTools } from "../src/tools.js";
import type { ProcessedMemory } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function tempDir(p: string): string { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; }
function processed(over: Partial<ProcessedMemory> = {}): ProcessedMemory {
  return { summary: "", decisions: [], preferences: [], openQuestions: [], artifacts: [], timeline: [], memories: [], operations: [], ...over };
}

describe("parseIdArray", () => {
  test("parses a plain id array", () => {
    expect(parseIdArray('["mem_a", "mem_b"]')).toEqual(["mem_a", "mem_b"]);
  });
  test("parses a fenced block and ignores prose", () => {
    expect(parseIdArray('drop these: ```json\n["mem_a"]\n``` done')).toEqual(["mem_a"]);
  });
  test("returns [] on junk", () => {
    expect(parseIdArray("nothing here")).toEqual([]);
  });
});

describe("archiveRecords (the re-curation actuator)", () => {
  test("archives the given beliefs recoverably and never touches pinned ones", async () => {
    const project = tempDir("peon-recurate-");
    const stateDir = tempDir("peon-recurate-state-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    await new PeonMemoryProcessor().processMemory({
      projectPath: project, reason: "seed",
      aiResult: processed({ decisions: ["Cloned the repo from GitHub.", "Use PostgreSQL for storage."] })
    });
    const before = (await tools.searchMemory({ projectPath: project, query: "" })).records;
    const cloneId = before.find((r) => r.record.content.includes("Cloned"))!.record.id;
    const pgId = before.find((r) => r.record.content.includes("PostgreSQL"))!.record.id;
    // Pin the durable one, then ask to archive BOTH — only the unpinned ephemeral one should go.
    await tools.updateMemory({ projectPath: project, id: pgId, pinned: true });

    const tools2 = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    const store = await (await import("../src/memory-store.js")).PeonMemoryStore.open({ projectPath: project });
    const archived = await store.archiveRecords([cloneId, pgId], "recurated");
    expect(archived).toBe(1); // pinned PostgreSQL belief protected

    const after = (await tools2.searchMemory({ projectPath: project, query: "" })).records;
    expect(after.find((r) => r.record.id === cloneId)!.record.status).toBe("archived");
    expect(after.find((r) => r.record.id === pgId)!.record.status).toBe("active");
  });
});
