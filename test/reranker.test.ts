import { describe, expect, it, vi } from "vitest";
import { parseOrder, rerankRecords, type FetchLike } from "../src/reranker.js";
import type { RankedMemoryRecord } from "../src/retrieval.js";
import type { MemoryRecord } from "../src/types.js";
import { loadPeonConfig } from "../src/config.js";

function rec(id: string, content: string): RankedMemoryRecord {
  const record: MemoryRecord = {
    id,
    type: "fact",
    content,
    normalized: content.toLowerCase(),
    scope: "project",
    status: "active",
    score: { importance: 0.5, confidence: 0.5 },
    source: { kind: "manual" },
    entities: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z"
  };
  return { record, score: 0.1, reasons: [], explanation: "" };
}

const config = { ...loadPeonConfig(), aiMode: "gated" as const, openRouterApiKey: "test-key" };

function mockFetch(content: string): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ choices: [{ message: { content } }] })
  }));
}

describe("parseOrder", () => {
  it("parses a plain JSON array of indices", () => {
    expect(parseOrder("[3, 1, 2]", 3)).toEqual([3, 1, 2]);
  });
  it("ignores prose and out-of-range numbers", () => {
    expect(parseOrder("Here you go: [2, 99, 1] done", 3)).toEqual([2, 1]);
  });
  it("returns [] on junk", () => {
    expect(parseOrder("no array here", 3)).toEqual([]);
  });
});

describe("rerankRecords", () => {
  const records = [rec("a", "alpha"), rec("b", "beta"), rec("c", "gamma")];

  it("reorders the head according to the model's ranking", async () => {
    const result = await rerankRecords("which is best", records, { config, fetchImpl: mockFetch("[3, 1, 2]") });
    expect(result.map((r) => r.record.id)).toEqual(["c", "a", "b"]);
  });

  it("appends omitted head items in original order (never drops a candidate)", async () => {
    const result = await rerankRecords("q", records, { config, fetchImpl: mockFetch("[2]") });
    expect(result.map((r) => r.record.id)).toEqual(["b", "a", "c"]);
  });

  it("leaves the tail beyond topK untouched", async () => {
    const result = await rerankRecords("q", records, { config, topK: 2, fetchImpl: mockFetch("[2, 1]") });
    expect(result.map((r) => r.record.id)).toEqual(["b", "a", "c"]);
  });

  it("returns input order on a failed response", async () => {
    const failing: FetchLike = vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) }));
    const result = await rerankRecords("q", records, { config, fetchImpl: failing });
    expect(result.map((r) => r.record.id)).toEqual(["a", "b", "c"]);
  });

  it("does not call the model without an API key", async () => {
    const spy = vi.fn();
    const noKey = { ...config, openRouterApiKey: undefined };
    const result = await rerankRecords("q", records, { config: noKey, fetchImpl: spy as unknown as FetchLike });
    expect(spy).not.toHaveBeenCalled();
    expect(result.map((r) => r.record.id)).toEqual(["a", "b", "c"]);
  });

  it("does not call the model for empty queries or single records", async () => {
    const spy = vi.fn();
    expect((await rerankRecords("", records, { config, fetchImpl: spy as unknown as FetchLike })).length).toBe(3);
    expect((await rerankRecords("q", [records[0]], { config, fetchImpl: spy as unknown as FetchLike })).length).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
