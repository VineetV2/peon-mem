import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  createEmbeddingClient,
  FallbackEmbeddingClient,
  LocalEmbeddingClient,
  localEmbed,
  LOCAL_EMBEDDING_MODEL,
  l2normalize,
  OpenRouterEmbeddingClient,
  OllamaEmbeddingClient,
  type EmbeddingClient
} from "../src/embeddings.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for empty, mismatched, or zero vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});

describe("localEmbed", () => {
  it("is deterministic — identical text yields identical vectors", () => {
    expect(localEmbed("use Gemini Flash-Lite")).toEqual(localEmbed("use Gemini Flash-Lite"));
  });

  it("produces L2-normalized vectors", () => {
    const vector = localEmbed("local-first memory daemon");
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("scores related text higher than unrelated text", () => {
    const query = localEmbed("database storage layer");
    const related = localEmbed("storage database engine for the project");
    const unrelated = localEmbed("the weather is sunny today");
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  });

  it("tolerates typos via shared character trigrams", () => {
    const correct = localEmbed("daemon process");
    const typo = localEmbed("deamon proces");
    const unrelated = localEmbed("banana smoothie");
    expect(cosineSimilarity(correct, typo)).toBeGreaterThan(cosineSimilarity(correct, unrelated));
  });

  it("returns a zero vector for empty input", () => {
    expect(localEmbed("   ").every((value) => value === 0)).toBe(true);
  });
});

describe("l2normalize", () => {
  it("leaves a zero vector unchanged", () => {
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("LocalEmbeddingClient", () => {
  it("embeds a batch and reports its model", async () => {
    const client = new LocalEmbeddingClient();
    const vectors = await client.embed(["one", "two"]);
    expect(vectors).toHaveLength(2);
    expect(client.model).toBe(LOCAL_EMBEDDING_MODEL);
  });
});

describe("FallbackEmbeddingClient", () => {
  it("falls back to local embeddings when the primary throws", async () => {
    const failing: EmbeddingClient = {
      model: "broken-model",
      embed: async () => {
        throw new Error("network down");
      }
    };
    let fellBack = false;
    const client = new FallbackEmbeddingClient(failing, new LocalEmbeddingClient(), () => {
      fellBack = true;
    });
    const vectors = await client.embed(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toEqual(localEmbed("hello"));
    expect(fellBack).toBe(true);
  });
});

describe("createEmbeddingClient", () => {
  it("returns null when embeddings are off", () => {
    expect(
      createEmbeddingClient({ config: { embeddingMode: "off", embeddingModel: undefined, openRouterApiKey: undefined } })
    ).toBeNull();
  });

  it("returns a local client in local mode", () => {
    const client = createEmbeddingClient({
      config: { embeddingMode: "local", embeddingModel: undefined, openRouterApiKey: undefined }
    });
    expect(client?.model).toBe(LOCAL_EMBEDDING_MODEL);
  });

  it("falls back to local when api mode lacks credentials", () => {
    const client = createEmbeddingClient({
      config: { embeddingMode: "api", embeddingModel: undefined, openRouterApiKey: undefined }
    });
    expect(client?.model).toBe(LOCAL_EMBEDDING_MODEL);
  });

  it("uses the api model when api mode has credentials", () => {
    const client = createEmbeddingClient({
      config: { embeddingMode: "api", embeddingModel: "openai/text-embedding-3-small", openRouterApiKey: "sk-test" }
    });
    expect(client?.model).toBe("openai/text-embedding-3-small");
  });
});

describe("OpenRouterEmbeddingClient query cache", () => {
  const makeFetch = () => {
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      calls += 1;
      const body = JSON.parse(String((init as { body: string }).body)) as { input: string[] };
      return {
        ok: true,
        json: async () => ({ data: body.input.map((_t, i) => ({ index: i, embedding: [calls, i + 1, 0.5] })) })
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, count: () => calls };
  };

  it("serves a repeated single-text (query) embed from cache — one network call, identical vector", async () => {
    const { fetchImpl, count } = makeFetch();
    const client = new OpenRouterEmbeddingClient({ apiKey: "k", model: `test-cache-${Date.now()}-a`, fetchImpl });
    const first = await client.embed(["how to run Exp42 on the cluster"]);
    const second = await client.embed(["how to run Exp42 on the cluster"]);
    expect(count()).toBe(1); // second call never hit the network
    expect(second).toEqual(first);
  });

  it("different text or model still goes to the network", async () => {
    const { fetchImpl, count } = makeFetch();
    const model = `test-cache-${Date.now()}-b`;
    const client = new OpenRouterEmbeddingClient({ apiKey: "k", model, fetchImpl });
    await client.embed(["query one"]);
    await client.embed(["query two"]);
    expect(count()).toBe(2);
    const other = new OpenRouterEmbeddingClient({ apiKey: "k", model: `${model}-other`, fetchImpl });
    await other.embed(["query one"]); // same text, different model → distinct key
    expect(count()).toBe(3);
  });

  it("batch (document) embeds are NOT cached — every batch hits the network", async () => {
    const { fetchImpl, count } = makeFetch();
    const client = new OpenRouterEmbeddingClient({ apiKey: "k", model: `test-cache-${Date.now()}-c`, fetchImpl });
    await client.embed(["doc a", "doc b"]);
    await client.embed(["doc a", "doc b"]);
    expect(count()).toBe(2);
  });
});

describe("query cache persistence", () => {
  it("appends computed query vectors to the persist file (append-only, base64 float32)", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const file = process.env.PEON_QUERY_EMBED_CACHE;
    if (!file) return; // persistence path is fixed at module load; only meaningful under npm test's env
    const model = `persist-${Date.now()}`;
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.25, -0.5, 1] }] })
    })) as unknown as typeof fetch;
    const client = new OpenRouterEmbeddingClient({ apiKey: "k", model, fetchImpl });
    await client.embed(["persist me"]);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const mine = lines.map((l) => JSON.parse(l)).filter((r) => String(r.k).startsWith(model));
    expect(mine.length).toBe(1);
    expect(typeof mine[0].v).toBe("string"); // base64, not a raw array
  });
});

describe("OllamaEmbeddingClient", () => {
  it("embeds via /api/embed, normalizes, and caches single-text calls", async () => {
    let calls = 0;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls += 1;
      expect(String(url)).toBe("http://127.0.0.1:11434/api/embed");
      const body = JSON.parse(String((init as { body: string }).body)) as { input: string[] };
      return { ok: true, json: async () => ({ embeddings: body.input.map(() => [3, 4, 0]) }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new OllamaEmbeddingClient({ model: `ollama-test-${Date.now()}`, fetchImpl });
    const [v] = await client.embed(["hello"]);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5); // l2-normalized
    await client.embed(["hello"]);
    expect(calls).toBe(1); // cache hit
  });

  it("throws on a count mismatch so the fallback chain can engage", async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ embeddings: [] }) })) as unknown as typeof fetch;
    const client = new OllamaEmbeddingClient({ model: `ollama-test-${Date.now()}-b`, fetchImpl });
    await expect(client.embed(["a", "b"])).rejects.toThrow(/returned 0 vectors for 2 inputs/);
  });
});

describe("createEmbeddingClient ollama mode", () => {
  it("wraps ollama in a fallback chain", () => {
    const client = createEmbeddingClient({
      config: { embeddingMode: "ollama", embeddingModel: "nomic-embed-text", openRouterApiKey: undefined, ollamaBaseUrl: undefined }
    });
    expect(client).not.toBeNull();
    expect(client!.model).toBe("nomic-embed-text"); // FallbackEmbeddingClient reports primary model
  });
});
