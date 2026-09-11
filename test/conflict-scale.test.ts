import { describe, expect, test } from "vitest";
import { detectMemoryConflicts, conflictScanStats } from "../src/quality.js";
import type { MemoryRecord } from "../src/types.js";

/**
 * detectMemoryConflicts compared every pair of records, and each pair rebuilt an
 * entity Map, re-normalized both contents, and constructed up to 16 RegExps. On a
 * 30k-record brain that is ~462M pairs — a CPU profile of the live daemon showed
 * 93% of all time in this function (createQualityReport 69%, hasWord 10%,
 * normalizeMemory 10%, escapeRegExp 4%), with the allocation churn driving GC and
 * blocking the event loop. Behaviour must not change; the work must.
 */

function rec(i: number, content: string, entities: string[]): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: `mem_fact_${i}`,
    type: "fact",
    content,
    entities,
    score: { importance: 0.5, confidence: 0.5 },
    status: "active",
    createdAt: now,
    updatedAt: now,
    sources: []
  } as MemoryRecord;
}

/** A corpus with genuine conflicts, near-misses, and unrelated noise. */
function corpus(n: number): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const topic = `topic${i % 40}`;
    out.push(rec(i, `belief ${i} about ${topic} with routine wording and no polarity`, [topic, `e${i % 17}`]));
  }
  // Real conflicts: shared entities + opposing language + same topic.
  out.push(rec(90001, "caching is enabled for the resolver on the primary path", ["resolver", "cache"]));
  out.push(rec(90002, "caching is disabled for the resolver on the primary path", ["resolver", "cache"]));
  out.push(rec(90003, "we use openrouter for the embedding calls in this project", ["openrouter", "embeddings"]));
  out.push(rec(90004, "we avoid openrouter for the embedding calls in this project", ["openrouter", "embeddings"]));
  // Near-miss: opposing words but no shared entity.
  out.push(rec(90005, "logging is enabled for the sweeper", ["sweeper"]));
  out.push(rec(90006, "logging is disabled for the janitor", ["janitor"]));
  return out;
}

describe("conflict detection at scale", () => {
  test("indexed scan finds exactly the conflicts the exhaustive scan finds", () => {
    // Buckets here stay under MAX_ENTITY_BUCKET, so the indexed scan is exactly
    // equivalent. Above that cap it deliberately skips ubiquitous-entity pairs.
    const records = corpus(400);

    const fast = detectMemoryConflicts(records);
    const slow = detectMemoryConflicts(records, { exhaustive: true });

    // Identical results, including order and reasons — this is a pure optimization.
    expect(fast).toEqual(slow);
    // And it genuinely found the planted conflicts rather than trivially returning [].
    expect(fast.length).toBeGreaterThanOrEqual(2);
    expect(fast.some((c) => c.reason.includes("enabled/disabled"))).toBe(true);
    expect(fast.some((c) => c.reason.includes("use/avoid"))).toBe(true);
  });

  test("pairs with no shared entity are never string-compared", () => {
    const records = corpus(400);

    detectMemoryConflicts(records, { exhaustive: true });
    const exhaustivePairs = conflictScanStats().pairsEvaluated;
    detectMemoryConflicts(records);
    const indexedPairs = conflictScanStats().pairsEvaluated;

    expect(exhaustivePairs).toBeGreaterThan(70_000);
    expect(indexedPairs).toBeLessThan(exhaustivePairs / 5);
  });

  test("the ubiquitous-entity cap bounds work as the brain grows", () => {
    // The cap is what makes growth sub-quadratic: without it, an entity attached to
    // a linear share of the brain yields a quadratic bucket. Set explicitly rather
    // than relying on the default, so this tests the mechanism, not the constant.
    detectMemoryConflicts(corpus(1000), { maxEntityBucket: 50 });
    const small = conflictScanStats().pairsEvaluated;
    detectMemoryConflicts(corpus(4000), { maxEntityBucket: 50 });
    const big = conflictScanStats().pairsEvaluated;

    // Quadratic would be ~16x for 4x the records.
    expect(big).toBeLessThan(small * 8);
  });

  test("the default cap keeps full fidelity on a realistic brain", () => {
    // Measured on the real 30.8k-record brain: cap 2000 finds all 112 conflicts the
    // exhaustive scan finds, in 2.3s instead of 12.6s. Guard the property here.
    const records = corpus(1500);
    expect(detectMemoryConflicts(records)).toEqual(detectMemoryConflicts(records, { exhaustive: true }));
  });

  test("a 6k-record brain completes quickly instead of pinning the CPU", () => {
    const records = corpus(6000);
    const started = Date.now();
    detectMemoryConflicts(records);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
