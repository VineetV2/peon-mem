import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import type { MemoryRecord } from "../src/types.js";

/**
 * Semantic dedup is O(n^2) pairwise cosine. At ~6.4k active records that is
 * ~20.5M comparisons x 1536 dims — it pinned the daemon's main thread at 99%
 * CPU and drove RSS past 1.9 GB, wedging every request. These tests pin the
 * cost down so a large brain can never take the daemon out again.
 */

function rec(i: number, content: string, status: MemoryRecord["status"] = "active"): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: `mem_fact_${i}`,
    type: "fact",
    content,
    entities: [],
    score: { importance: 0.5, confidence: 0.5 },
    status,
    createdAt: now,
    updatedAt: now,
    sources: []
  } as MemoryRecord;
}

async function freshStore(prefix: string): Promise<PeonMemoryStore> {
  const projectPath = await mkdtemp(join(tmpdir(), prefix));
  return PeonMemoryStore.open({ projectPath });
}

describe("semantic dedup at scale", () => {
  test("still merges duplicates on a normal-sized brain", async () => {
    const store = await freshStore("peon-dedup-small-");
    const records = [
      rec(1, "Peon stores memory in the project .peon folder."),
      rec(2, "Peon stores memory in the project .peon folder."),
      rec(3, "Completely unrelated belief about GPU scheduling.")
    ];

    const { records: out, merged } = await store.mergeSimilarActiveRecords(records);

    expect(merged).toBe(1);
    expect(out.filter((r) => r.status === "active")).toHaveLength(2);
  });

  test("a huge active set does not run the quadratic pass", async () => {
    const store = await freshStore("peon-dedup-huge-");
    // Above the guard threshold. Brute force here would be ~12.5M comparisons;
    // the guard must bail out instead of attempting it.
    const records = Array.from({ length: 5000 }, (_, i) => rec(i, `distinct belief number ${i}`));

    const started = Date.now();
    const { records: out, merged } = await store.mergeSimilarActiveRecords(records, 0.9, { maxActive: 1000 });
    const elapsed = Date.now() - started;

    // Bails out cheaply and returns the input untouched rather than mangling it.
    expect(merged).toBe(0);
    expect(out).toHaveLength(5000);
    expect(out.every((r) => r.status === "active")).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  test("the default guard still admits a real large brain, so dedup is not silently off", async () => {
    const store = await freshStore("peon-dedup-default-");
    // Master Project 700B has ~6.4k active records. With the bucketed path this is
    // sub-second, so the default guard must NOT skip a brain that size — otherwise
    // the backstop would quietly disable dedup on exactly the brains that need it.
    const records = Array.from({ length: 6500 }, (_, i) => rec(i, `belief ${i} :: marker-${i}`));
    const { merged } = await store.mergeSimilarActiveRecords(records);
    expect(merged).toBeGreaterThan(0);
  });

  test("the guard threshold is configurable", async () => {
    const store = await freshStore("peon-dedup-cfg-");
    const records = [
      rec(1, "Identical belief text for the merge check."),
      rec(2, "Identical belief text for the merge check.")
    ];

    // Threshold of 1 means even this tiny set is 'too big' to dedup.
    const { merged } = await store.mergeSimilarActiveRecords(records, 0.9, { maxActive: 1 });
    expect(merged).toBe(0);
  });
});

const WORDS = "daemon vector schema cluster retrieval latency budget parser cache index prompt token quota sandbox migration rollback throughput shard replica cursor lease quorum snapshot".split(" ");

/** Varied content, so records are genuinely distinct rather than all near-duplicates. */
function varied(i: number): string {
  const rnd = (n: number) => WORDS[(i * 7919 + n * 104729) % WORDS.length];
  return `${rnd(1)} ${rnd(2)} ${rnd(3)} ${rnd(4)} note ${i} regarding ${rnd(5)} and ${rnd(6)}`;
}

describe("semantic dedup — bucketed candidate search", () => {
  test("matches exhaustive merges (within LSH tolerance) for a fraction of the work", async () => {
    const store = await freshStore("peon-dedup-recall-");
    const records: MemoryRecord[] = [];
    for (let i = 0; i < 600; i += 1) records.push(rec(i, varied(i)));
    for (let i = 0; i < 40; i += 1) {
      records.push(rec(10_000 + i, `duplicated belief ${i}: the daemon must never block the event loop`));
      records.push(rec(20_000 + i, `duplicated belief ${i}: the daemon must never block the event loop`));
    }

    const fast = await store.mergeSimilarActiveRecords(records, 0.9, { maxActive: 100_000 });
    const exhaustive = await store.mergeSimilarActiveRecords(records, 0.9, {
      maxActive: 100_000,
      exhaustive: true
    });

    // Bucketing is probabilistic: a pair can miss every band. Recall must stay
    // very high, but demanding exact parity would be dishonest about the method.
    expect(exhaustive.merged).toBeGreaterThan(0);
    expect(fast.merged).toBeGreaterThanOrEqual(Math.floor(exhaustive.merged * 0.97));
    expect(fast.merged).toBeLessThanOrEqual(exhaustive.merged);
    // Strictly less work even at this small size; the ratio test below measures
    // the saving at a scale where it actually matters.
    expect(fast.comparisons).toBeLessThan(exhaustive.comparisons);
  });

  test("work stays sub-quadratic on a brain of mostly-distinct beliefs", async () => {
    const store = await freshStore("peon-dedup-large-");
    // The real pathological shape: Master Project 700B holds ~6.4k active records
    // that mostly do NOT merge, so kept[] grows to full size and every record
    // scans all of it. That is the ~20.5M-comparison case that pinned the CPU.
    const build = (n: number) =>
      Array.from({ length: n }, (_, i) => rec(i, `${varied(i)} :: distinct-marker-${i}-${(i * 2654435761) % 1000003}`));

    const small = await store.mergeSimilarActiveRecords(build(1000), 0.9, { maxActive: 100_000 });
    const big = await store.mergeSimilarActiveRecords(build(4000), 0.9, { maxActive: 100_000 });
    const exhaustiveBig = await store.mergeSimilarActiveRecords(build(4000), 0.9, {
      maxActive: 100_000,
      exhaustive: true
    });

    // Sanity: this really is the non-merging shape that makes the old scan quadratic.
    expect(exhaustiveBig.comparisons).toBeGreaterThan(1_000_000);
    // 4x the records under a quadratic pass means ~16x the work.
    expect(big.comparisons).toBeLessThan(small.comparisons * 8);
    // Bucketing cuts the pathological case by ~4-5x on these (256-dim, highly
    // correlated) local trigram vectors. Real 1536-dim API embeddings spread
    // across buckets better, so this is the conservative end of the win.
    expect(big.comparisons).toBeLessThan(exhaustiveBig.comparisons / 3);
  });

  test("the pass yields to the event loop instead of starving it", async () => {
    const store = await freshStore("peon-dedup-yield-");
    const records = Array.from({ length: 4000 }, (_, i) => rec(i, varied(i)));

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await store.mergeSimilarActiveRecords(records, 0.9, { maxActive: 100_000, exhaustive: true });
    clearInterval(timer);

    expect(ticks).toBeGreaterThan(0);
  });
});
