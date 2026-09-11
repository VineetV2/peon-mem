import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EmbeddingStore, embeddingCacheStats, resetEmbeddingCaches } from "../src/embedding-store.js";

/**
 * The sidecar cache made retrieval fast but was unbounded and per-store, and the
 * daemon caches a store per project. Eight projects pinned 60,288 vectors /
 * 338 MB of native backing, driving RSS past 1.9 GB until GC pressure pegged the
 * CPU and the daemon stopped answering. Caches must be bounded and reclaimable.
 */

afterEach(() => resetEmbeddingCaches());

async function storeWith(prefix: string, vectors: number): Promise<EmbeddingStore> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(dir, "brain"), { recursive: true });
  const lines = Array.from({ length: vectors }, (_, i) =>
    JSON.stringify({ id: `r${i}`, model: "m", hash: `h${i}`, vector: [0.1, 0.2, 0.3, 0.4] })
  );
  await writeFile(join(dir, "brain", "embeddings.jsonl"), lines.join("\n") + "\n", "utf8");
  return EmbeddingStore.open(dir);
}

describe("embedding sidecar cache is bounded", () => {
  test("only a few stores keep a cache; older ones are evicted", async () => {
    const stores = [];
    for (let i = 0; i < 5; i += 1) stores.push(await storeWith(`peon-cache-${i}-`, 20));
    for (const s of stores) await s.vectorById();

    // Without a bound this would be 5 — one full sidecar per project touched.
    expect(embeddingCacheStats().cachedStores).toBeLessThanOrEqual(2);
  });

  test("an evicted store still returns correct vectors by re-reading from disk", async () => {
    const a = await storeWith("peon-cache-evicted-", 10);
    const first = await a.vectorById();
    expect(first.size).toBe(10);

    // Touch enough other stores to push `a` out of the cache.
    for (let i = 0; i < 4; i += 1) {
      const other = await storeWith(`peon-cache-push-${i}-`, 10);
      await other.vectorById();
    }

    const again = await a.vectorById();
    expect(again.size).toBe(10);
    expect(again.get("r3")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  test("an idle cache is released so a quiet daemon settles back down", async () => {
    const s = await storeWith("peon-cache-ttl-", 10);
    await s.vectorById();
    expect(embeddingCacheStats().cachedStores).toBe(1);

    // Simulate the TTL (5 min) elapsing rather than sleeping the test out.
    embeddingCacheStats().expireOlderThan(Date.now() + 10 * 60 * 1000);
    expect(embeddingCacheStats().cachedStores).toBe(0);

    // Still correct after the cache is gone.
    expect((await s.vectorById()).size).toBe(10);
  });

  test("repeat reads within the window still hit the cache", async () => {
    const s = await storeWith("peon-cache-hit-", 10);
    await s.vectorById();
    const before = embeddingCacheStats().reads;
    await s.vectorById();
    await s.vectorById();
    // Cached reads must not re-parse the sidecar from disk each time.
    expect(embeddingCacheStats().diskReads).toBe(before);
  });
});
