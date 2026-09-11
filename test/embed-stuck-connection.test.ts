import { describe, expect, test } from "vitest";
import { OllamaEmbeddingClient } from "../src/embeddings.js";
import { loadPeonConfig } from "../src/config.js";

/**
 * Measured live: Ollama answered a 64-text embedding batch in seconds, but the ~310 KB
 * response sat in the M1's TCP send queue on that one keep-alive connection, never reaching
 * the laptop, while fresh connections carried the same payload in 3.3 s. Node's fetch waits
 * 300 s for response headers, so each stuck request stalled a consolidation for 5 minutes.
 */

const ok = (n: number) =>
  new Response(JSON.stringify({ embeddings: Array.from({ length: n }, (_, i) => [i + 1, 1, 0]) }), { status: 200 });

/** A request that never answers until its signal aborts, like a wedged connection. */
const stuck = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

function client(fetchImpl: typeof fetch, requestTimeoutMs = 80) {
  return new OllamaEmbeddingClient({ model: "qwen3-embedding:0.6b", baseUrl: "http://m1.test:11434", fetchImpl, requestTimeoutMs });
}

describe("embedding requests survive a wedged connection", () => {
  test("a request that never answers is retried once on a fresh connection", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return seen.length === 1 ? stuck(init) : ok(2);
    }) as unknown as typeof fetch;

    const started = Date.now();
    const vectors = await client(fetchImpl).embed(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.connection).toBe("close"); // the retry cannot reuse the wedged socket
  });

  test("gives up after the retry instead of waiting Node's 300 s", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => stuck(init)) as unknown as typeof fetch;
    const started = Date.now();
    await expect(client(fetchImpl).embed(["a"])).rejects.toThrow(/did not answer within 0\.08 s/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("an HTTP error is not retried", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("input too long", { status: 400 });
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).embed(["a"])).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  test("config reads PEON_EMBED_TIMEOUT_MS (default 90 s)", () => {
    expect(loadPeonConfig({ PEON_EMBED_TIMEOUT_MS: "45000" }).embedTimeoutMs).toBe(45_000);
    expect(loadPeonConfig({}).embedTimeoutMs).toBe(90_000);
  });
});
