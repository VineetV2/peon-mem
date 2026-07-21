import { describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryType } from "../src/types.js";
import { diversifyByMMR, expandByEntityGraph, rankMemoryRecords, selectMemoryRecordsForContext } from "../src/retrieval.js";
import type { RankedMemoryRecord } from "../src/retrieval.js";

const now = "2026-06-01T00:00:00.000Z";

function record(input: {
  id: string;
  type: MemoryType;
  content: string;
  entities?: string[];
  importance?: number;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}): MemoryRecord {
  return {
    id: input.id,
    type: input.type,
    content: input.content,
    normalized: input.content.toLowerCase(),
    scope: "project",
    status: "active",
    score: {
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 0.5
    },
    source: { kind: "manual" },
    entities: input.entities ?? [],
    createdAt: input.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? input.createdAt ?? "2026-05-01T00:00:00.000Z"
  };
}

describe("Retrieval Engine v2", () => {
  it("ranks records by query terms, entity/file matches, type weights, quality, and recency", () => {
    const ranked = rankMemoryRecords(
      [
        record({
          id: "generic",
          type: "summary",
          content: "Payment work is in progress.",
          importance: 0.8,
          confidence: 0.8,
          updatedAt: "2026-05-30T00:00:00.000Z"
        }),
        record({
          id: "target",
          type: "decision",
          content: "Route payment webhook retries through the durable queue.",
          entities: ["StripeWebhook", "src/payments/webhook.ts"],
          importance: 0.9,
          confidence: 0.95,
          updatedAt: "2026-05-31T00:00:00.000Z"
        }),
        record({
          id: "old",
          type: "artifact",
          content: "Legacy payment webhook prototype lived in docs/old-webhook.md.",
          entities: ["docs/old-webhook.md"],
          importance: 0.9,
          confidence: 0.9,
          updatedAt: "2025-06-01T00:00:00.000Z"
        }),
        record({
          id: "unmatched",
          type: "decision",
          content: "Use SQLite for local storage.",
          importance: 1,
          confidence: 1,
          updatedAt: "2026-05-31T00:00:00.000Z"
        })
      ],
      "StripeWebhook payment src/payments/webhook.ts",
      { now }
    );

    // The clearly-best match (most query terms + entity + file + recent + high quality) ranks first.
    expect(ranked[0].record.id).toBe("target");
    // The non-matching record is gated out entirely.
    expect(ranked.map((item) => item.record.id)).not.toContain("unmatched");
    // The matched records all surface.
    expect(ranked.map((item) => item.record.id).sort()).toEqual(["generic", "old", "target"]);
    expect(ranked[0].explanation).toContain("matched entity StripeWebhook");
    expect(ranked[0].explanation).toContain("matched file src/payments/webhook.ts");
  });

  it("uses type weights and quality scores to order otherwise similar matches", () => {
    const ranked = rankMemoryRecords(
      [
        record({
          id: "timeline",
          type: "timeline",
          content: "Auth migration discussed during standup.",
          importance: 0.4,
          confidence: 0.5
        }),
        record({
          id: "decision",
          type: "decision",
          content: "Auth migration will use the existing session table.",
          importance: 0.8,
          confidence: 0.9
        })
      ],
      "auth migration",
      { now }
    );

    expect(ranked.map((item) => item.record.id)).toEqual(["decision", "timeline"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("diversifies near-duplicate records (MMR) so a distinct belief surfaces above paraphrases", () => {
    const rank = (id: string, content: string, score: number, entities: string[] = []): RankedMemoryRecord => ({
      record: record({ id, type: "fact", content, entities }),
      score,
      reasons: [],
      explanation: ""
    });
    // Three near-identical records (highest scores) + one distinct belief (lower score).
    const ordered = diversifyByMMR([
      rank("dup-1", "Nightly deploys run on the staging cluster.", 0.9, ["staging"]),
      rank("dup-2", "Nightly deploys run on the staging cluster.", 0.88, ["staging"]),
      rank("dup-3", "Nightly deploys run on the staging cluster.", 0.86, ["staging"]),
      rank("distinct", "Database backups are stored in cold object storage.", 0.7, ["backups"])
    ]);

    // The single most relevant record is always first (top hit never displaced).
    expect(ordered[0].record.id).toBe("dup-1");
    // The distinct belief is promoted ahead of the redundant paraphrases for coverage,
    // landing immediately after the top hit instead of last.
    expect(ordered[1].record.id).toBe("distinct");
  });

  it("expands by entity graph (1-hop) to surface related beliefs that didn't match the query", () => {
    const seedRecord = record({
      id: "seed",
      type: "decision",
      content: "Route payment webhook retries through the durable queue.",
      entities: ["StripeWebhook", "src/payments/webhook.ts"]
    });
    const seeds = rankMemoryRecords([seedRecord], "StripeWebhook", { now });
    const pool = [
      seedRecord,
      record({ id: "related", type: "fact", content: "The durable queue uses Redis streams.", entities: ["StripeWebhook"] }),
      record({ id: "unrelated", type: "fact", content: "The CLI uses commander.", entities: ["commander"] })
    ];

    const neighbors = expandByEntityGraph(seeds, pool);
    const ids = neighbors.map((n) => n.record.id);
    expect(ids).toContain("related");      // shares the StripeWebhook entity
    expect(ids).not.toContain("unrelated"); // shares nothing
    expect(ids).not.toContain("seed");      // the seed itself is excluded
    expect(neighbors[0].explanation).toContain("linked via entity");
  });

  it("spreading activation: a belief sharing TWO entities outranks one sharing one (multi-source summation)", () => {
    const seed = rankMemoryRecords(
      [record({ id: "seed", type: "decision", content: "Seed about alpha and beta.", entities: ["alpha", "beta"] })],
      "alpha beta",
      { now }
    );
    const pool = [
      seed[0].record,
      record({ id: "two", type: "fact", content: "Shares alpha and beta.", entities: ["alpha", "beta"] }),
      record({ id: "one", type: "fact", content: "Shares only alpha.", entities: ["alpha"] })
    ];
    const neighbors = expandByEntityGraph(seed, pool);
    const ids = neighbors.map((n) => n.record.id);
    expect(ids.indexOf("two")).toBeLessThan(ids.indexOf("one")); // two-entity link wins
    expect(neighbors.find((n) => n.record.id === "two")!.score).toBeGreaterThan(
      neighbors.find((n) => n.record.id === "one")!.score
    );
  });

  it("hub damping: a link through a rare entity outranks a link through a super-hub", () => {
    // "hub" is mentioned by many beliefs; "rare" by few → rare should transmit more activation.
    const hubHolders = Array.from({ length: 12 }, (_, i) =>
      record({ id: `hub${i}`, type: "fact", content: `mentions hub ${i}`, entities: ["hub"] })
    );
    const seed = rankMemoryRecords(
      [record({ id: "seed", type: "decision", content: "Seed via hub and rare.", entities: ["hub", "rare"] })],
      "hub rare",
      { now }
    );
    const pool = [
      seed[0].record,
      ...hubHolders,
      record({ id: "viaRare", type: "fact", content: "Linked by the rare entity.", entities: ["rare"] }),
      record({ id: "viaHub", type: "fact", content: "Linked by the hub entity only.", entities: ["hub"] })
    ];
    const neighbors = expandByEntityGraph(seed, pool, { hubDegreeCap: 100 }); // keep hub in play to test damping
    const rare = neighbors.find((n) => n.record.id === "viaRare");
    const viaHub = neighbors.find((n) => n.record.id === "viaHub");
    expect(rare).toBeDefined();
    expect(rare!.score).toBeGreaterThan(viaHub?.score ?? 0);
  });

  it("returns no NaN-scored neighbors when damping is 0 (regression: maxAct=0 guard)", () => {
    const seed = rankMemoryRecords(
      [record({ id: "seed", type: "decision", content: "About alpha.", entities: ["alpha"] })],
      "alpha",
      { now }
    );
    const pool = [seed[0].record, record({ id: "n", type: "fact", content: "Also alpha.", entities: ["alpha"] })];
    const neighbors = expandByEntityGraph(seed, pool, { damping: 0 });
    expect(neighbors.every((n) => Number.isFinite(n.score))).toBe(true);
    expect(neighbors.length).toBe(0); // zero activation → no neighbours, no NaN
  });

  it("selects ranked records within a context character budget", () => {
    const ranked = rankMemoryRecords(
      [
        record({
          id: "keep-1",
          type: "decision",
          content: "Use Redis streams for notifications.",
          importance: 0.9,
          confidence: 0.9
        }),
        record({
          id: "skip-too-large",
          type: "artifact",
          content: "notifications ".repeat(80),
          importance: 0.8,
          confidence: 0.8
        }),
        record({
          id: "keep-2",
          type: "fact",
          content: "Notifications are tenant scoped.",
          importance: 0.7,
          confidence: 0.8
        })
      ],
      "notifications",
      { now }
    );

    const selection = selectMemoryRecordsForContext(ranked, { maxChars: 120 });

    expect(selection.records.map((item) => item.record.id)).toEqual(["keep-1", "keep-2"]);
    expect(selection.totalChars).toBeLessThanOrEqual(120);
    expect(selection.omitted.map((item) => item.record.id)).toEqual(["skip-too-large"]);
  });
});
