import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmbeddingStore, encodeVector, decodeVector } from "../src/embedding-store.js";
import type { EmbeddingClient } from "../src/embeddings.js";
import type { MemoryRecord } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRecord(id: string, content: string): MemoryRecord {
  return {
    id,
    type: "decision",
    content,
    normalized: content.toLowerCase(),
    scope: "project",
    status: "active",
    score: { importance: 0.8, confidence: 0.8 },
    source: { kind: "ai_processing" },
    entities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

class StubClient implements EmbeddingClient {
  readonly model = "stub-v1";
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) =>
      text.includes("alpha") ? [1, 0, 0] : text.includes("beta") ? [0, 1, 0] : [0, 0, 1]
    );
  }
}

async function openStore(memoryDir: string): Promise<EmbeddingStore> {
  return EmbeddingStore.open(memoryDir);
}

describe("EmbeddingStore", () => {
  it("computes vectors for all records on first sync and persists them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    const client = new StubClient();
    const records = [makeRecord("a", "alpha decision"), makeRecord("b", "beta decision")];

    const result = await store.sync(records, client);
    expect(result.computed).toBe(2);
    expect(result.reused).toBe(0);
    expect(result.vectorById.get("a")).toEqual([1, 0, 0]);
    expect(result.vectorById.get("b")).toEqual([0, 1, 0]);

    const persisted = await readFile(join(dir, "brain", "embeddings.jsonl"), "utf8");
    expect(persisted).toContain('"id":"a"');
    expect(persisted).toContain('"model":"stub-v1"');
  });

  it("reuses unchanged vectors without recomputing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    const client = new StubClient();
    const records = [makeRecord("a", "alpha decision"), makeRecord("b", "beta decision")];

    await store.sync(records, client);
    expect(client.calls).toBe(1);

    const second = await store.sync(records, client);
    expect(second.computed).toBe(0);
    expect(second.reused).toBe(2);
    expect(client.calls).toBe(1); // no second embed call
  });

  it("recomputes only records whose content changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    const client = new StubClient();

    await store.sync([makeRecord("a", "alpha decision"), makeRecord("b", "beta decision")], client);
    const result = await store.sync(
      [makeRecord("a", "alpha decision"), makeRecord("b", "gamma decision changed")],
      client
    );

    expect(result.computed).toBe(1);
    expect(result.reused).toBe(1);
    expect(result.vectorById.get("b")).toEqual([0, 0, 1]); // re-embedded as "other"
  });

  it("prunes vectors for deleted records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    const client = new StubClient();

    await store.sync([makeRecord("a", "alpha decision"), makeRecord("b", "beta decision")], client);
    const result = await store.sync([makeRecord("a", "alpha decision")], client);

    expect(result.pruned).toBe(1);
    const map = await store.vectorById();
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(false);
  });

  it("returns empty map and does nothing when client is null (embeddings off)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    const result = await store.sync([makeRecord("a", "alpha decision")], null);
    expect(result.vectorById.size).toBe(0);
    expect(result.computed).toBe(0);
  });

  it("persists vectors as base64 float32 (`vec`), not a JSON float64 array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    const store = await openStore(dir);
    await store.sync([makeRecord("a", "alpha decision")], new StubClient());
    const persisted = await readFile(join(dir, "brain", "embeddings.jsonl"), "utf8");
    expect(persisted).toContain('"vec":"');       // base64 field present
    expect(persisted).not.toMatch(/"vector":\[/);  // legacy array gone
    // and it reads back to the same vector
    expect((await store.vectorById()).get("a")).toEqual([1, 0, 0]);
  });
});

describe("embedding-store base64-float32 codec", () => {
  it("round-trips a vector within float32 relative precision", () => {
    const v = [0, 1, -1, 0.5, -0.3333333, 1e-7, 12345.678];
    const back = decodeVector(encodeVector(v));
    expect(back).not.toBeNull();
    expect(back!.length).toBe(v.length);
    // float32 gives ~7 significant digits → assert RELATIVE error, not absolute decimal places
    for (let i = 0; i < v.length; i++) {
      expect(Math.abs(back![i] - v[i])).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(v[i])));
    }
  });

  it("preserves cosine similarity through float32 encoding (retrieval-safe)", () => {
    const a = Array.from({ length: 1536 }, (_, i) => Math.sin(i));
    const b = Array.from({ length: 1536 }, (_, i) => Math.cos(i));
    const cos = (x: number[], y: number[]) => {
      let d = 0, nx = 0, ny = 0;
      for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
      return d / (Math.sqrt(nx) * Math.sqrt(ny));
    };
    expect(cos(decodeVector(encodeVector(a))!, decodeVector(encodeVector(b))!)).toBeCloseTo(cos(a, b), 5);
  });

  it("decodeVector rejects malformed / misaligned input instead of throwing", () => {
    expect(decodeVector("")).toBeNull();
    expect(decodeVector("YWJj")).toBeNull(); // "abc" = 3 bytes, not a multiple of 4
  });

  it("load() reads BOTH a legacy `vector` array line AND a new base64 `vec` line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-emb-"));
    dirs.push(dir);
    mkdirSync(join(dir, "brain"), { recursive: true });
    const legacy = { id: "old", model: "m", hash: "h1", vector: [0.1, 0.2, 0.3] };
    const modern = { id: "new", model: "m", hash: "h2", vec: encodeVector([0.4, 0.5, 0.6]) };
    writeFileSync(join(dir, "brain", "embeddings.jsonl"), JSON.stringify(legacy) + "\n" + JSON.stringify(modern) + "\n");

    const map = await (await EmbeddingStore.open(dir)).load();
    expect(map.size).toBe(2);
    expect(map.get("old")!.vector).toEqual([0.1, 0.2, 0.3]);
    expect(map.get("new")!.vector[0]).toBeCloseTo(0.4, 4);
    expect(map.get("new")!.vector[2]).toBeCloseTo(0.6, 4);
  });
});
