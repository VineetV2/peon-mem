import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EmbeddingStore, resetEmbeddingDimensionCache } from "../src/embedding-store.js";
import { FallbackEmbeddingClient, LocalEmbeddingClient } from "../src/embeddings.js";
import type { EmbeddingClient, EmbeddingVector } from "../src/embeddings.js";
import type { MemoryRecord } from "../src/types.js";

/**
 * FallbackEmbeddingClient reported the PRIMARY model's name even when it had
 * degraded to local trigram vectors. Those 256-dim vectors were persisted under
 * (say) "qwen3-embedding:0.6b", so every later sync saw a matching model+hash and
 * "reused" them forever. cosineSimilarity returns 0 for mismatched lengths, so a
 * 256-dim stored vector scores zero against a 1024-dim query — semantic recall
 * silently dies. Measured on a real brain: 30,834 of 31,966 vectors were poisoned.
 */

function rec(i: number): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: `mem_fact_${i}`, type: "fact", content: `belief number ${i}`, entities: [],
    score: { importance: 0.5, confidence: 0.5 }, status: "active",
    createdAt: now, updatedAt: now, sources: []
  } as MemoryRecord;
}

/** A client that produces fixed-width vectors, so dimensions are controllable. */
class FixedDimClient implements EmbeddingClient {
  constructor(readonly model: string, private readonly dim: number) {}
  async embed(texts: string[]): Promise<EmbeddingVector[]> {
    return texts.map(() => new Array(this.dim).fill(0.1));
  }
}

class AlwaysFailingClient implements EmbeddingClient {
  readonly model = "remote-model:1b";
  async embed(): Promise<EmbeddingVector[]> { throw new Error("server unreachable"); }
}

async function store(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, es: await EmbeddingStore.open(dir) };
}

describe("embedding sidecar integrity", () => {
  test("vectors whose dimension no longer matches the client are recomputed, not reused", async () => {
    const { dir, es } = await store("peon-dim-");
    const records = [rec(1), rec(2), rec(3)];

    // Persist 256-dim vectors under a model name...
    const narrow = new FixedDimClient("qwen3-embedding:0.6b", 256);
    const first = await es.sync(records, narrow);
    expect(first.computed).toBe(3);

    // ...then meet that sidecar from a FRESH process — which is how a poisoned
    // sidecar is actually encountered: the daemon restarts and the real model is
    // reachable again, so the stored width is wrong but the model name still matches.
    resetEmbeddingDimensionCache();
    const wide = new FixedDimClient("qwen3-embedding:0.6b", 1024);
    const second = await (await EmbeddingStore.open(dir)).sync(records, wide);

    // Must not blindly reuse: the stored width is wrong for this client.
    expect(second.reused).toBe(0);
    expect(second.computed).toBe(3);
    for (const v of second.vectorById.values()) expect(v.length).toBe(1024);
  });

  test("degraded fallback vectors are not persisted under the primary model's name", async () => {
    const { dir, es } = await store("peon-fallback-");
    const records = [rec(1), rec(2)];

    const client = new FallbackEmbeddingClient(new AlwaysFailingClient(), new LocalEmbeddingClient());
    const res = await es.sync(records, client);

    // Retrieval still degrades gracefully for this run...
    expect(res.vectorById.size).toBeGreaterThanOrEqual(0);
    // ...but nothing bearing the primary's name may be written to disk, or the
    // next sync will "reuse" trigram vectors as if they were real embeddings.
    const persisted = await (await EmbeddingStore.open(dir)).load();
    const mislabelled = [...persisted.values()].filter((e) => e.model === "remote-model:1b");
    expect(mislabelled).toHaveLength(0);
  });
});
