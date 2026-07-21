import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PeonMemoryProcessor } from "../src/processor.js";
import { createPeonTools } from "../src/tools.js";
import type { ProcessedMemory } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function processed(over: Partial<ProcessedMemory> = {}): ProcessedMemory {
  return { summary: "", decisions: [], preferences: [], openQuestions: [], artifacts: [], timeline: [], memories: [], operations: [], ...over };
}

describe("cross-project recall (isolated by default, pull on demand)", () => {
  test("from project X you can recall an active belief that lives in project Y", async () => {
    const projX = tempProject("peon-x-");
    const projY = tempProject("peon-y-");
    const stateDir = tempProject("peon-xstate-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    const processor = new PeonMemoryProcessor();

    // Seed distinct beliefs into each project (deterministic, no LLM).
    await processor.processMemory({ projectPath: projX, reason: "seed", aiResult: processed({ decisions: ["Project X uses PostgreSQL for storage."] }) });
    await processor.processMemory({ projectPath: projY, reason: "seed", aiResult: processed({ decisions: ["Project Y uses Stripe for billing and webhooks."] }) });

    // Default isolation: X's own context must NOT contain Y's belief.
    const xContext = await tools.getContext({ projectPath: projX, query: "billing" });
    const xBlob = JSON.stringify(xContext);
    expect(xBlob).not.toContain("Stripe");

    // Explicit cross-project pull from X, excluding X → finds Y's belief, attributed to Y.
    const result = await tools.crossProjectSearch({
      query: "billing stripe payments",
      projectPaths: [projX, projY],
      excludeProjectPath: projX
    });

    expect(result.projectsSearched).toEqual([projY]);
    const stripeHit = result.results.find((r) => r.record.content.includes("Stripe"));
    expect(stripeHit).toBeDefined();
    expect(stripeHit?.projectPath).toBe(projY);
    // It must not leak X's own beliefs (X was excluded).
    expect(result.results.some((r) => r.record.content.includes("PostgreSQL"))).toBe(false);
  });

  test("only surfaces ACTIVE beliefs across projects, never superseded history", async () => {
    const projY = tempProject("peon-y2-");
    const stateDir = tempProject("peon-y2state-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    const processor = new PeonMemoryProcessor();

    await processor.processMemory({ projectPath: projY, reason: "s1", aiResult: processed({ decisions: ["Auth uses session cookies."] }) });
    // Supersede it with a deterministic operation.
    const targetId = (await import("../src/memory-store.js")).memoryRecordId("decision", "Auth uses session cookies.");
    await processor.processMemory({
      projectPath: projY,
      reason: "s2",
      aiResult: processed({ operations: [{ op: "supersede", targetId, replacement: { type: "decision", content: "Auth uses JWT bearer tokens (replaces session cookies)." } }] })
    });

    const result = await tools.crossProjectSearch({ query: "auth tokens cookies session", projectPaths: [projY] });
    expect(result.results.some((r) => r.record.content.includes("JWT bearer tokens"))).toBe(true);
    // Every cross-project hit is a CURRENT belief — never superseded history.
    expect(result.results.every((r) => r.record.status === "active")).toBe(true);
    // The old, standalone belief is not surfaced (the active one only mentions it parenthetically).
    expect(result.results.some((r) => r.record.content === "Auth uses session cookies.")).toBe(false);
  });
});
