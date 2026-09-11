import { describe, expect, test } from "vitest";
import { detectDuplicates, duplicateScanStats } from "../src/overview.js";
import type { MemoryRecord } from "../src/types.js";

/**
 * detectDuplicates compared every active pair with a jaccard over word sets — on a
 * 6.4k-active brain that is ~20.4M comparisons, just to return the top 5 pairs. A
 * CPU profile of the live daemon attributed 12.3% of busy time to it (jaccard 9.5%,
 * detectDuplicates 2.8%), on both the /overview endpoint and the consolidation
 * auto-merge path.
 */

function rec(i: number, content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: `mem_fact_${i}`,
    type: "fact",
    content,
    entities: [],
    score: { importance: 0.5, confidence: 0.5 },
    status: "active",
    createdAt: now,
    updatedAt: now,
    sources: []
  } as MemoryRecord;
}

const WORDS = "daemon vector schema cluster retrieval latency budget parser cache index prompt token quota sandbox migration rollback throughput shard replica cursor lease quorum snapshot pipeline".split(" ");

function corpus(n: number): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const w = (k: number) => WORDS[(i * 7919 + k * 104729) % WORDS.length];
    out.push(rec(i, `${w(1)} ${w(2)} ${w(3)} ${w(4)} ${w(5)} distinct note ${i}`));
  }
  // Planted near-duplicates: same wording, trivial difference.
  out.push(rec(80001, "the resolver caches embeddings on the primary retrieval path for speed"));
  out.push(rec(80002, "the resolver caches embeddings on the primary retrieval path for speed today"));
  out.push(rec(80003, "rollback the migration when the shard quorum is not reachable"));
  out.push(rec(80004, "rollback the migration when the shard quorum is not reachable anymore"));
  return out;
}

describe("duplicate detection at scale", () => {
  test("indexed scan finds the same pairs as the exhaustive scan", () => {
    const records = corpus(500);
    const fast = detectDuplicates(records, { limit: 50 });
    const slow = detectDuplicates(records, { limit: 50, exhaustive: true });

    expect(fast).toEqual(slow);
    expect(fast.length).toBeGreaterThanOrEqual(2);
  });

  test("it evaluates far fewer pairs than the exhaustive scan", () => {
    const records = corpus(500);

    detectDuplicates(records, { exhaustive: true });
    const exhaustivePairs = duplicateScanStats().pairsEvaluated;
    detectDuplicates(records);
    const indexedPairs = duplicateScanStats().pairsEvaluated;

    expect(exhaustivePairs).toBeGreaterThan(100_000);
    // This fixture draws from a 24-word vocabulary, so almost nothing is "rare" and
    // blocking can only do so much (~2.7x). On the real 30.8k-record brain, where
    // beliefs carry distinctive terms, it is 6x fewer pairs with identical results.
    expect(indexedPairs).toBeLessThan(exhaustivePairs / 2);
  });

  test("a 6k-record brain completes fast instead of pinning the CPU", () => {
    const records = corpus(6000);
    const started = Date.now();
    detectDuplicates(records);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("still returns the strongest pairs first, capped at limit", () => {
    const records = corpus(300);
    const pairs = detectDuplicates(records, { limit: 2 });
    expect(pairs.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    }
  });
});
