import { describe, expect, it } from "vitest";
import { currentAsOf, changesBetween } from "../src/temporal.js";
import type { MemoryRecord, MemoryStatus } from "../src/types.js";

function rec(input: {
  id: string;
  content: string;
  status?: MemoryStatus;
  createdAt: string;
  updatedAt?: string;
  supersededBy?: string;
}): MemoryRecord {
  return {
    id: input.id,
    type: "decision",
    content: input.content,
    normalized: input.content.toLowerCase(),
    scope: "project",
    status: input.status ?? "active",
    score: { importance: 0.6, confidence: 0.7 },
    source: { kind: "manual" },
    entities: [],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    supersededBy: input.supersededBy
  };
}

// A belief that changed over time: v1 held Jan–Mar, then superseded by v2 in March.
const v1 = rec({ id: "v1", content: "Embeddings via OpenRouter API.", status: "superseded", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z", supersededBy: "v2" });
const v2 = rec({ id: "v2", content: "Embeddings on local Ollama.", status: "active", createdAt: "2026-03-01T00:00:00.000Z" });
const retired = rec({ id: "q1", content: "Should we run on every session end?", status: "superseded", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" });
const all = [v1, v2, retired];

describe("currentAsOf", () => {
  it("returns the belief that was current at a past time, not its later replacement", () => {
    const feb = currentAsOf(all, "2026-02-15T00:00:00.000Z").map((r) => r.id);
    expect(feb).toContain("v1");      // still current in Feb
    expect(feb).not.toContain("v2");  // didn't exist yet
    expect(feb).toContain("q1");      // still open in Feb
  });

  it("returns the replacement once it is current and excludes the superseded original", () => {
    const now = currentAsOf(all, "2026-05-01T00:00:00.000Z").map((r) => r.id);
    expect(now).toContain("v2");      // current truth
    expect(now).not.toContain("v1");  // already replaced
    expect(now).not.toContain("q1");  // retired in April
  });

  it("excludes beliefs that did not yet exist", () => {
    const dec = currentAsOf(all, "2025-12-01T00:00:00.000Z").map((r) => r.id);
    expect(dec).toEqual([]);
  });
});

describe("changesBetween", () => {
  it("reports a supersession with its replacement inside the window", () => {
    const changes = changesBetween(all, "2026-02-15T00:00:00.000Z", "2026-03-15T00:00:00.000Z");
    const superseded = changes.find((c) => c.record.id === "v1");
    expect(superseded?.kind).toBe("superseded");
    expect(superseded?.replacementId).toBe("v2");
    // v2 was also added in this window.
    expect(changes.some((c) => c.kind === "added" && c.record.id === "v2")).toBe(true);
  });

  it("distinguishes a retired (no-successor) belief from a superseded one", () => {
    const changes = changesBetween(all, "2026-03-15T00:00:00.000Z", "2026-04-15T00:00:00.000Z");
    const retiredEntry = changes.find((c) => c.record.id === "q1");
    expect(retiredEntry?.kind).toBe("retired");
    expect(retiredEntry?.replacementId).toBeUndefined();
  });

  it("returns changes in chronological order", () => {
    const changes = changesBetween(all, "2026-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
    const times = changes.map((c) => new Date(c.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});
