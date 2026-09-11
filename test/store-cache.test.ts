import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createPeonTools, openStoreCacheStats } from "../src/tools.js";

/**
 * storesByProject kept a PeonMemoryStore for every project the daemon ever touched
 * and never released one. Each store carries an EmbeddingStore (whose sidecar cache
 * is bounded separately), so an unbounded store map quietly pins memory for projects
 * nobody is working in. A heap snapshot found 8 stores alive holding 411 MB of
 * ArrayBuffers between them.
 */

async function project(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("open store cache is bounded", () => {
  test("touching many projects does not keep a store for each one", async () => {
    const tools = createPeonTools();
    for (let i = 0; i < 10; i += 1) {
      const path = await project(`peon-storecache-${i}-`);
      await tools.startSession({ projectPath: path, client: "test" });
    }

    expect(openStoreCacheStats().openStores).toBeLessThanOrEqual(4);
  });

  test("an evicted project still works — it just reopens its store", async () => {
    const tools = createPeonTools();
    const first = await project("peon-storecache-first-");
    const started = await tools.startSession({ projectPath: first, client: "test" });
    await tools.recordMessage({ sessionId: started.sessionId, role: "user", content: "hello from the first project" });

    // Push the first project out of the cache.
    for (let i = 0; i < 8; i += 1) {
      const path = await project(`peon-storecache-push-${i}-`);
      await tools.startSession({ projectPath: path, client: "test" });
    }

    // Still fully functional after eviction.
    const context = await tools.getContext({ projectPath: first });
    expect(context).toBeDefined();
    const again = await tools.startSession({ projectPath: first, client: "test" });
    expect(again.sessionId).toBeTruthy();
  });
});
