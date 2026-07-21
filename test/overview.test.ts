import { describe, expect, test } from "vitest";
import { summarizeBeliefs, detectDuplicates, computeTokenSavings, enrichInjection, filterStrayProjects } from "../src/overview.js";
import type { MemoryRecord } from "../src/types.js";
import type { SelectedInjectionMetadata } from "../src/injection.js";

const NOW = "2026-06-14T00:00:00.000Z";
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "r", type: "decision", content: "c", normalized: "c", scope: "project", status: "active",
    score: { importance: 0.5, confidence: 0.5 }, source: { kind: "ai_processing" }, entities: [],
    createdAt: NOW, updatedAt: NOW, ...over
  };
}

describe("summarizeBeliefs", () => {
  test("counts by status and pins", () => {
    const counts = summarizeBeliefs([
      rec({ id: "1", status: "active", pinned: true }),
      rec({ id: "2", status: "active" }),
      rec({ id: "3", status: "superseded" }),
      rec({ id: "4", status: "conflicted" }),
      rec({ id: "5", status: "stale" }),
      rec({ id: "6", status: "archived", summaryOf: ["3"] })
    ]);
    expect(counts).toEqual({ active: 2, superseded: 1, conflicts: 1, stale: 1, archived: 1, summaries: 1, pinned: 1, total: 6 });
  });
});

describe("filterStrayProjects", () => {
  test("drops empty nested subdir brains but keeps real nested projects and roots", () => {
    const projects = [
      { projectPath: "/repo", active: 50 },
      { projectPath: "/repo/peon-mcp", active: 31 },   // nested but substantial → keep
      { projectPath: "/repo/docs", active: 0 },        // nested + empty → drop
      { projectPath: "/repo/peon-mcp/src", active: 0 },// nested + empty → drop
      { projectPath: "/other", active: 0 }             // top-level, not nested → keep
    ];
    const kept = filterStrayProjects(projects).map((p) => p.projectPath);
    expect(kept).toEqual(["/repo", "/repo/peon-mcp", "/other"]);
  });
});

describe("detectDuplicates", () => {
  test("flags near-identical active beliefs of the same type", () => {
    const dups = detectDuplicates([
      rec({ id: "a", content: "Open the index.html file in the browser to play the game" }),
      rec({ id: "b", content: "Open index.html in the browser to play the game" }),
      rec({ id: "c", content: "Use PostgreSQL for the production database layer" })
    ]);
    expect(dups).toHaveLength(1);
    expect([dups[0].aId, dups[0].bId].sort()).toEqual(["a", "b"]);
  });
  test("does not flag beliefs of different types even if worded alike", () => {
    const dups = detectDuplicates([
      rec({ id: "a", type: "decision", content: "deploy the service on friday afternoon" }),
      rec({ id: "b", type: "artifact", content: "deploy the service on friday afternoon" })
    ]);
    expect(dups).toHaveLength(0);
  });
  test("ignores superseded records", () => {
    const dups = detectDuplicates([
      rec({ id: "a", content: "same words here for the test", status: "active" }),
      rec({ id: "b", content: "same words here for the test", status: "superseded" })
    ]);
    expect(dups).toHaveLength(0);
  });
});

describe("computeTokenSavings", () => {
  test("returns null until both arms have a session", () => {
    expect(computeTokenSavings([{ projectPath: "/p", peonEnabled: true, totalTokens: 100 }], "/p")).toBeNull();
  });
  test("computes per-session savings when both arms exist", () => {
    const savings = computeTokenSavings(
      [
        { projectPath: "/p", peonEnabled: true, totalTokens: 100 },
        { projectPath: "/p", peonEnabled: true, totalTokens: 200 },
        { projectPath: "/p", peonEnabled: false, totalTokens: 500 },
        { projectPath: "/other", peonEnabled: false, totalTokens: 9999 }
      ],
      "/p"
    );
    expect(savings).toEqual({ onAvg: 150, offAvg: 500, onSessions: 2, offSessions: 1, savedPerSession: 350 });
  });
});

describe("enrichInjection", () => {
  test("joins selected ids back to their content and drops unknown ids", () => {
    const selected: SelectedInjectionMetadata[] = [
      { id: "a", scope: "global", type: "fact", status: "active", score: 0.9123, whySelected: "", source: { kind: "manual" }, chars: 10 },
      { id: "missing", scope: "project", type: "decision", status: "active", score: 0.5, whySelected: "", source: { kind: "manual" }, chars: 10 }
    ];
    const items = enrichInjection(selected, [rec({ id: "a", content: "NJIT uses SLURM" })]);
    expect(items).toEqual([{ id: "a", scope: "global", type: "fact", content: "NJIT uses SLURM", score: 0.91 }]);
  });
});
