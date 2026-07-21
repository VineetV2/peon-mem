import { describe, expect, it } from "vitest";
import { recallAtK, reciprocalRank, ndcgAtK, aggregate, scoreQuery } from "../src/eval-metrics.js";

const rel = new Set(["a", "b", "c"]);

describe("recallAtK", () => {
  it("counts relevant hits in the top-k over total relevant", () => {
    expect(recallAtK(["a", "x", "b", "y"], rel, 4)).toBeCloseTo(2 / 3);
    expect(recallAtK(["a", "b", "c"], rel, 3)).toBe(1);
    expect(recallAtK(["x", "y"], rel, 2)).toBe(0);
  });
  it("respects k (only the top-k count)", () => {
    expect(recallAtK(["x", "y", "a"], rel, 2)).toBe(0);
    expect(recallAtK(["x", "y", "a"], rel, 3)).toBeCloseTo(1 / 3);
  });
  it("is 1 when nothing is relevant (nothing to miss)", () => {
    expect(recallAtK(["x"], new Set(), 5)).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["x", "a", "b"], rel)).toBe(1 / 2);
    expect(reciprocalRank(["a"], rel)).toBe(1);
    expect(reciprocalRank(["x", "y"], rel)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1 for a perfectly ranked result", () => {
    expect(ndcgAtK(["a", "b", "c"], rel, 3)).toBeCloseTo(1);
  });
  it("penalizes relevant items ranked lower", () => {
    const perfect = ndcgAtK(["a", "b", "c"], rel, 3);
    const worse = ndcgAtK(["x", "a", "b"], rel, 3);
    expect(worse).toBeLessThan(perfect);
    expect(worse).toBeGreaterThan(0);
  });
});

describe("aggregate", () => {
  it("means per-query scores into Recall@K / MRR / nDCG@K", () => {
    const a = scoreQuery(["a", "b", "c"], rel, 3); // perfect
    const b = scoreQuery(["x", "y", "z"], rel, 3); // miss
    const agg = aggregate([a, b]);
    expect(agg.queries).toBe(2);
    expect(agg.recallAtK).toBeCloseTo(0.5);
    expect(agg.mrr).toBeCloseTo(0.5);
  });
  it("handles the empty set", () => {
    expect(aggregate([])).toEqual({ queries: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0 });
  });
});
