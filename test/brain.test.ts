import { describe, expect, test } from "vitest";
import { reinforce, resolveConflicts, autoMergeDuplicates, findTopicClusters, compressTopicClusters, runSleepCycle } from "../src/brain.js";
import type { MemoryRecord } from "../src/types.js";

const NOW = "2026-06-15T00:00:00.000Z";
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "r", type: "decision", content: "c", normalized: "c", scope: "project", status: "active",
    score: { importance: 0.6, confidence: 0.8 }, source: { kind: "ai_processing" }, entities: [],
    createdAt: NOW, updatedAt: NOW, ...over
  };
}

describe("reinforce (use it or lose it, but nothing is lost)", () => {
  test("recalled beliefs gain strength, recallCount, and a fresh timestamp", () => {
    const { records } = reinforce([rec({ id: "a", strength: 0.5 })], ["a"], NOW);
    expect(records[0].strength).toBeGreaterThan(0.5);
    expect(records[0].recallCount).toBe(1);
    expect(records[0].lastRecalledAt).toBe(NOW);
  });
  test("unrecalled beliefs relax but protected (pinned/global) never drop below their anchor", () => {
    const out = reinforce(
      [rec({ id: "p", pinned: true, strength: 0.9, score: { importance: 0.9, confidence: 0.8 } }),
       rec({ id: "u", strength: 0.9, score: { importance: 0.3, confidence: 0.8 } })],
      [], NOW
    ).records;
    expect(out.find((r) => r.id === "p")!.strength).toBeGreaterThanOrEqual(0.9);
    expect(out.find((r) => r.id === "u")!.strength).toBeLessThan(0.9);
  });
});

describe("resolveConflicts (autonomous, loser archived not deleted)", () => {
  test("higher-confidence belief wins; loser is archived and recoverable", () => {
    const records = [
      rec({ id: "win", content: "the database is enabled", entities: ["database"], score: { importance: 0.6, confidence: 0.9 } }),
      rec({ id: "lose", content: "the database is disabled", entities: ["database"], score: { importance: 0.6, confidence: 0.4 } })
    ];
    const { records: out, actions } = resolveConflicts(records, NOW);
    expect(out.find((r) => r.id === "lose")!.status).toBe("archived");
    expect(out.find((r) => r.id === "win")!.status).toBe("active");
    expect(actions.some((a) => a.type === "resolve_conflict")).toBe(true);
    // Nothing deleted — both records still present.
    expect(out).toHaveLength(2);
  });
});

describe("autoMergeDuplicates", () => {
  test("merges near-duplicates, archives the dropped raw copy with a back-link", () => {
    const records = [
      rec({ id: "a", content: "Open index.html in the browser to play the game", strength: 0.8 }),
      rec({ id: "b", content: "Open the index.html file in the browser to play the game", strength: 0.4 })
    ];
    const { records: out, actions } = autoMergeDuplicates(records, NOW);
    expect(actions.some((a) => a.type === "merge_duplicate")).toBe(true);
    const dropped = out.find((r) => r.id === "b")!;
    expect(dropped.status).toBe("archived");
    expect(dropped.summarizedBy).toBe("a");
    expect(out.find((r) => r.id === "a")!.status).toBe("active");
  });
});

describe("topic compression (the brain's gist-formation)", () => {
  test("findTopicClusters groups active beliefs by dominant entity past the threshold", () => {
    const records = [
      rec({ id: "1", entities: ["njit"] }), rec({ id: "2", entities: ["njit"] }),
      rec({ id: "3", entities: ["njit"] }), rec({ id: "4", entities: ["other"] })
    ];
    const clusters = findTopicClusters(records, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entity).toBe("njit");
    expect(clusters[0].members).toHaveLength(3);
  });
  test("compresses a cluster into one summary and archives the raw detail", async () => {
    const records = [
      rec({ id: "1", content: "NJIT uses SLURM", entities: ["njit"] }),
      rec({ id: "2", content: "NJIT has A100 GPUs", entities: ["njit"] }),
      rec({ id: "3", content: "NJIT docs on github", entities: ["njit"] })
    ];
    const summarize = async () => "NJIT Wulver: SLURM, A100 GPUs, docs on github.";
    const { records: out, actions } = await compressTopicClusters(records, summarize, NOW, { minClusterSize: 3, makeId: (e) => `summary_${e}` });
    const summary = out.find((r) => r.summaryOf);
    expect(summary).toBeDefined();
    expect(summary!.type).toBe("summary");
    expect(summary!.summaryOf).toEqual(["1", "2", "3"]);
    // Raw detail archived (recoverable), linked back to the summary.
    expect(out.filter((r) => r.status === "archived")).toHaveLength(3);
    expect(out.find((r) => r.id === "1")!.summarizedBy).toBe("summary_njit");
    expect(actions.some((a) => a.type === "compress_cluster")).toBe(true);
  });
  test("never compresses pinned or global beliefs", () => {
    const records = [
      rec({ id: "1", entities: ["njit"], pinned: true }), rec({ id: "2", entities: ["njit"], scope: "global" }),
      rec({ id: "3", entities: ["njit"] })
    ];
    expect(findTopicClusters(records, 3)).toHaveLength(0);
  });
});

describe("runSleepCycle (the full autonomous pass)", () => {
  test("orchestrates reinforce → resolve → merge → compress and logs every action", async () => {
    const records = [
      rec({ id: "recall-me", content: "use postgres", entities: ["db"] }),
      rec({ id: "win", content: "auth is enabled", entities: ["auth"], score: { importance: 0.6, confidence: 0.9 } }),
      rec({ id: "lose", content: "auth is disabled", entities: ["auth"], score: { importance: 0.6, confidence: 0.3 } })
    ];
    const { records: out, actions } = await runSleepCycle(records, {
      recalledIds: ["recall-me"],
      now: NOW,
      makeSummaryId: (e) => `summary_${e}`
    });
    expect(out.find((r) => r.id === "recall-me")!.recallCount).toBe(1);
    expect(out.find((r) => r.id === "lose")!.status).toBe("archived");
    expect(actions.map((a) => a.type)).toContain("reinforce");
    expect(actions.map((a) => a.type)).toContain("resolve_conflict");
  });
});
