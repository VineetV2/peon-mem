import { describe, expect, it } from "vitest";
import { rankMemoryRecords } from "../src/retrieval.js";
import type { MemoryRecord } from "../src/types.js";

function makeRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    type: "decision",
    content,
    normalized: content.toLowerCase(),
    scope: "project",
    status: "active",
    score: { importance: 0.8, confidence: 0.8 },
    source: { kind: "ai_processing" },
    entities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("hybrid semantic retrieval", () => {
  const records = [
    makeRecord("r1", "synchronize the widget pipeline"),
    makeRecord("r2", "totally different banana content")
  ];

  it("drops records with no lexical overlap when semantics are off", () => {
    const ranked = rankMemoryRecords(records, "frobnicate");
    expect(ranked).toHaveLength(0);
  });

  it("surfaces a semantically-aligned record with zero keyword overlap", () => {
    const ranked = rankMemoryRecords(records, "frobnicate", {
      semantic: {
        queryVector: [1, 0],
        vectorById: new Map([
          ["r1", [1, 0]], // aligned with the query
          ["r2", [0, 1]] // orthogonal — below threshold
        ])
      }
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].record.id).toBe("r1");
    expect(ranked[0].reasons.some((reason) => reason.kind === "semantic")).toBe(true);
  });

  it("blends semantic score on top of lexical score for ranking", () => {
    const lexicalOnly = rankMemoryRecords(records, "widget");
    expect(lexicalOnly[0].record.id).toBe("r1");
    const baseScore = lexicalOnly[0].score;

    const withSemantic = rankMemoryRecords(records, "widget", {
      semantic: {
        queryVector: [1, 0],
        vectorById: new Map([["r1", [1, 0]]])
      }
    });
    const boosted = withSemantic.find((item) => item.record.id === "r1");
    expect(boosted).toBeDefined();
    expect(boosted!.score).toBeGreaterThan(baseScore);
  });

  it("ignores semantic similarity below the minimum threshold", () => {
    const ranked = rankMemoryRecords(records, "widget", {
      semantic: {
        queryVector: [1, 0],
        vectorById: new Map([["r1", [0.99, 0.14]]]), // cosine ~0.99 but test the floor
        minSimilarity: 0.999
      }
    });
    const item = ranked.find((entry) => entry.record.id === "r1");
    expect(item).toBeDefined();
    expect(item!.reasons.some((reason) => reason.kind === "semantic")).toBe(false);
  });
});
