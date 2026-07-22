import { describe, expect, it } from "vitest";
import { demoteStaleShadows, type RankedMemoryRecord } from "../src/retrieval.js";
import type { MemoryRecord } from "../src/types.js";

function ranked(
  id: string,
  content: string,
  createdAt: string,
  options: Partial<MemoryRecord> & { score?: number } = {}
): RankedMemoryRecord {
  const { score, ...overrides } = options;
  const record: MemoryRecord = {
    id,
    type: "decision",
    content,
    normalized: content.toLowerCase(),
    scope: "project",
    status: "active",
    score: { importance: 0.9, confidence: 0.8 },
    source: { kind: "manual" },
    entities: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides
  } as MemoryRecord;
  return { record, score: score ?? 0.1, reasons: [], explanation: "match" };
}

const DAY = 24 * 60 * 60 * 1000;
const OLD = new Date(Date.now() - 30 * DAY).toISOString();
const NEW = new Date(Date.now() - 1 * DAY).toISOString();

describe("demoteStaleShadows", () => {
  it("demotes an older near-duplicate below the newer belief", () => {
    const oldBelief = ranked("old", "all projects collapse into the Documents brain", OLD, { score: 0.12 });
    const newBelief = ranked("new", "hierarchy: global parent brain with rooted child brains", NEW, { score: 0.1 });
    const vectors = new Map<string, number[]>([
      ["old", [1, 0, 0]],
      ["new", [0.95, 0.31, 0]] // cosine ≈ 0.95 — same fact, different era
    ]);
    const out = demoteStaleShadows([oldBelief, newBelief], vectors);
    expect(out[0].record.id).toBe("new");
    expect(out[1].record.id).toBe("old");
    expect(out[1].score).toBeLessThan(0.1);
    expect(out[1].explanation).toContain("stale shadow of newer belief new");
  });

  it("uses entity overlap to catch moderate-similarity conflicts", () => {
    const oldBelief = ranked("old", "global brain lives in the documents folder", OLD, {
      entities: ["global brain"],
      score: 0.12
    });
    const newBelief = ranked("new", "global brain moved to application support with child brains", NEW, {
      entities: ["global brain"],
      score: 0.1
    });
    const vectors = new Map<string, number[]>([
      ["old", [1, 0, 0]],
      ["new", [0.7, 0.71, 0]] // cosine ≈ 0.70 — below hard threshold, entity overlap rescues
    ]);
    const out = demoteStaleShadows([oldBelief, newBelief], vectors);
    expect(out[0].record.id).toBe("new");
    expect(out[1].explanation).toContain("stale shadow");
  });

  it("leaves unrelated, pinned, and same-era beliefs alone", () => {
    const pinned = ranked("pinned", "old but pinned truth", OLD, { pinned: true, score: 0.12 });
    const fresh = ranked("fresh", "new phrasing of pinned truth", NEW, { score: 0.1 });
    const unrelated = ranked("other", "completely different topic", OLD, { score: 0.08 });
    const sameEraA = ranked("a", "twin belief one", NEW, { score: 0.07 });
    const sameEraB = ranked("b", "twin belief two", NEW, { score: 0.06 });
    const vectors = new Map<string, number[]>([
      ["pinned", [1, 0, 0]],
      ["fresh", [0.99, 0.14, 0]],
      ["other", [0, 0, 1]],
      ["a", [0, 1, 0]],
      ["b", [0.1, 0.99, 0]]
    ]);
    const out = demoteStaleShadows([pinned, fresh, unrelated, sameEraA, sameEraB], vectors);
    expect(out.map((r) => r.record.id)).toEqual(["pinned", "fresh", "other", "a", "b"]);
    expect(out.every((r) => !r.explanation.includes("stale shadow"))).toBe(true);
  });

  it("no-ops without vectors", () => {
    const a = ranked("a", "one", OLD, { score: 0.12 });
    const b = ranked("b", "two", NEW, { score: 0.1 });
    expect(demoteStaleShadows([a, b], undefined)).toEqual([a, b]);
  });
});
