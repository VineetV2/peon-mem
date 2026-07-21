import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryType } from "../src/types.js";
import {
  applyMemoryQualityReport,
  createQualityReport,
  deduplicateMemoryRecords,
  detectMemoryConflicts,
  markStaleMemoryRecords,
  promoteMemoryRecords,
  serializeMemoryQualityReport,
  summarizeMemoryQualityReport
} from "../src/quality.js";

const baseDate = "2026-06-05T00:00:00.000Z";

function record(
  id: string,
  content: string,
  options: Partial<MemoryRecord> & { type?: MemoryType } = {}
): MemoryRecord {
  const type = options.type ?? "fact";
  return {
    id,
    type,
    content,
    normalized: content.toLowerCase().replace(/\s+/g, " ").trim(),
    scope: "project",
    status: "active",
    score: { importance: 0.5, confidence: 0.8 },
    source: { kind: "ai_processing" },
    entities: [],
    createdAt: baseDate,
    updatedAt: baseDate,
    ...options
  };
}

describe("Peon memory quality engine", () => {
  test("deduplicates records by normalized content and type while keeping the strongest record", () => {
    const older = record("older", "Use Vitest for MCP tests.", {
      type: "decision",
      score: { importance: 0.6, confidence: 0.7 },
      entities: ["vitest"],
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    const stronger = record("stronger", " use vitest for mcp tests ", {
      type: "decision",
      score: { importance: 0.9, confidence: 0.95 },
      entities: ["mcp"],
      updatedAt: "2026-06-03T00:00:00.000Z"
    });
    const differentType = record("summary", "Use Vitest for MCP tests.", { type: "summary" });

    const result = deduplicateMemoryRecords([older, stronger, differentType]);

    expect(result.records.map((item) => item.id)).toEqual(["stronger", "summary"]);
    expect(result.duplicates).toEqual([
      {
        duplicateId: "older",
        keptId: "stronger",
        key: "decision:use vitest for mcp tests"
      }
    ]);
    expect(result.records[0].entities).toEqual(["mcp", "vitest"]);
    expect(result.records[0].score).toEqual({ importance: 0.9, confidence: 0.95 });
  });

  test("detects deterministic conflicts for the same entity with opposing language", () => {
    const enabled = record("enabled", "Redis cache is enabled for project context.", {
      type: "decision",
      entities: ["Redis cache"]
    });
    const disabled = record("disabled", "Redis cache is disabled for project context.", {
      type: "decision",
      entities: ["Redis cache"]
    });
    const unrelated = record("unrelated", "SQLite storage is enabled for local events.", {
      type: "decision",
      entities: ["SQLite"]
    });

    const conflicts = detectMemoryConflicts([enabled, unrelated, disabled]);

    expect(conflicts).toEqual([
      {
        entity: "Redis cache",
        leftId: "enabled",
        rightId: "disabled",
        reason: "opposing enabled/disabled language"
      }
    ]);
  });

  test("marks active records stale when updatedAt is older than the configured age", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const old = record("old", "Old implementation note.", {
      updatedAt: "2026-03-01T00:00:00.000Z"
    });
    const fresh = record("fresh", "Recent implementation note.", {
      updatedAt: "2026-06-01T00:00:00.000Z"
    });
    const conflicted = record("conflicted", "Historical conflict.", {
      status: "conflicted",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const result = markStaleMemoryRecords([old, fresh, conflicted], { now, staleAfterDays: 60 });

    expect(result.records.map((item) => [item.id, item.status])).toEqual([
      ["old", "stale"],
      ["fresh", "active"],
      ["conflicted", "conflicted"]
    ]);
    expect(result.staleIds).toEqual(["old"]);
  });

  test("promotes repeated or important records by increasing importance without exceeding one", () => {
    const repeated = record("repeated", "Use structured memory records.", {
      score: { importance: 0.5, confidence: 0.8 }
    });
    const important = record("important", "Migration deadline is Friday.", {
      score: { importance: 0.88, confidence: 0.8 }
    });
    const ordinary = record("ordinary", "Review notes later.", {
      score: { importance: 0.4, confidence: 0.8 }
    });

    const result = promoteMemoryRecords([repeated, important, ordinary], {
      repeatedContent: ["use structured memory records", "Use structured memory records!"],
      importantTerms: ["deadline"]
    });

    expect(result.promoted.map((item) => item.id)).toEqual(["repeated", "important"]);
    expect(result.records.find((item) => item.id === "repeated")?.score.importance).toBe(0.7);
    expect(result.records.find((item) => item.id === "important")?.score.importance).toBe(1);
    expect(result.records.find((item) => item.id === "ordinary")?.score.importance).toBe(0.4);
  });

  test("produces a quality report with dedupe, conflict, stale, and promotion signals", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const records = [
      record("a", "Docker is enabled for tests.", {
        type: "decision",
        entities: ["Docker"],
        updatedAt: "2026-06-04T00:00:00.000Z"
      }),
      record("b", "Docker is disabled for tests.", {
        type: "decision",
        entities: ["Docker"],
        updatedAt: "2026-06-04T00:00:00.000Z"
      }),
      record("dup", "docker is enabled for tests", {
        type: "decision",
        entities: ["Docker"],
        score: { importance: 0.95, confidence: 0.9 },
        updatedAt: "2026-06-05T00:00:00.000Z"
      }),
      record("old", "Legacy note.", {
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    ];

    const report = createQualityReport(records, {
      now,
      staleAfterDays: 90,
      repeatedContent: ["Legacy note.", "legacy note"],
      importantTerms: ["docker"]
    });

    expect(report.inputCount).toBe(4);
    expect(report.outputCount).toBe(3);
    expect(report.duplicates).toHaveLength(1);
    expect(report.conflicts).toEqual([
      {
        entity: "Docker",
        leftId: "dup",
        rightId: "b",
        reason: "opposing enabled/disabled language"
      }
    ]);
    expect(report.staleIds).toEqual(["old"]);
    expect(report.promotedIds).toEqual(["dup", "b", "old"]);
    expect(report.records.find((item) => item.id === "old")?.status).toBe("stale");
    expect(report.records.find((item) => item.id === "dup")?.status).toBe("conflicted");
    expect(report.records.find((item) => item.id === "b")?.status).toBe("conflicted");
  });

  test("applies a quality report back to records and summarizes the audit trail", () => {
    const now = new Date("2026-06-05T00:00:00.000Z");
    const records = [
      record("older", "Use Vitest for MCP tests.", {
        type: "decision",
        score: { importance: 0.4, confidence: 0.6 },
        updatedAt: "2026-06-01T00:00:00.000Z"
      }),
      record("kept", "use vitest for mcp tests", {
        type: "decision",
        score: { importance: 0.8, confidence: 0.9 },
        updatedAt: "2026-06-04T00:00:00.000Z"
      }),
      record("old", "Legacy note.", {
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    ];
    const report = createQualityReport(records, {
      now,
      staleAfterDays: 90,
      repeatedContent: ["Legacy note.", "legacy note"]
    });

    const result = applyMemoryQualityReport(records, report);

    expect(result.records.map((item) => [item.id, item.status, item.score.importance])).toEqual([
      ["kept", "active", 0.8],
      ["old", "stale", 0.7]
    ]);
    expect(result.records[0]).not.toBe(report.records[0]);
    expect(result.audit).toEqual({
      inputCount: 3,
      outputCount: 2,
      removedDuplicateCount: 1,
      conflictCount: 0,
      staleCount: 1,
      promotedCount: 1,
      changedCount: 1,
      unchangedCount: 1,
      removedIds: ["older"],
      updatedIds: ["old"],
      retainedIds: ["kept"]
    });
  });

  test("summarizes and serializes quality reports as JSON-safe data", () => {
    const records = [
      record("a", "Docker is enabled for tests.", {
        type: "decision",
        entities: ["Docker"]
      }),
      record("b", "Docker is disabled for tests.", {
        type: "decision",
        entities: ["Docker"]
      })
    ];
    const report = createQualityReport(records, { importantTerms: ["docker"] });

    expect(summarizeMemoryQualityReport(report, records)).toEqual({
      inputCount: 2,
      outputCount: 2,
      removedDuplicateCount: 0,
      conflictCount: 1,
      staleCount: 0,
      promotedCount: 2,
      changedCount: 2,
      unchangedCount: 0,
      removedIds: [],
      updatedIds: ["a", "b"],
      retainedIds: []
    });

    const serialized = serializeMemoryQualityReport(report);

    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
    expect(serialized.audit).toEqual(summarizeMemoryQualityReport(report));
    expect(serialized.records.map((item) => item.id)).toEqual(["a", "b"]);
    expect(serialized.conflicts).toEqual([
      {
        entity: "Docker",
        leftId: "a",
        rightId: "b",
        reason: "opposing enabled/disabled language"
      }
    ]);
  });
});
