import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import type { EmbeddingClient } from "../src/embeddings.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Stub embedder mapping concepts to fixed vectors, so we can prove the store
 * retrieves by MEANING (not keywords) deterministically. "model/cost" concepts
 * map near each other; unrelated concepts are orthogonal.
 */
class ConceptEmbeddingClient implements EmbeddingClient {
  readonly model = "concept-stub-v1";
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const t = text.toLowerCase();
      const cost = /gemini|flash|cheap|cost|budget|spend|inexpensive|affordable/.test(t) ? 1 : 0;
      const ui = /button|css|color|layout|frontend|ui/.test(t) ? 1 : 0;
      const db = /database|sqlite|storage|persist|schema/.test(t) ? 1 : 0;
      const vec = [cost, ui, db];
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map((v) => v / norm);
    });
  }
}

describe("semantic memory search (end-to-end)", () => {
  it("retrieves a record by meaning when there is no keyword overlap", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-semantic-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({
      projectPath,
      embeddingClient: new ConceptEmbeddingClient()
    });

    // Seed structured memory directly (simulating processed brain records).
    await store.replaceMemoryRecords([
      buildRecord("m1", "decision", "Adopt Gemini Flash-Lite to keep model spend low."),
      buildRecord("m2", "decision", "Use a teal accent color for primary buttons."),
      buildRecord("m3", "artifact", "schema.sql defines the SQLite persistence layer.")
    ]);

    // Query shares NO keywords with m1, but is conceptually about model cost.
    const ranked = await store.rankRecords("how do we keep our budget affordable", { limit: 5 });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].record.id).toBe("m1");
    expect(ranked[0].reasons.some((reason) => reason.kind === "semantic")).toBe(true);
  });

  it("ranks the conceptually-closest record first among several", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-semantic-rank-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({
      projectPath,
      embeddingClient: new ConceptEmbeddingClient()
    });

    await store.replaceMemoryRecords([
      buildRecord("m1", "decision", "Adopt Gemini Flash-Lite to keep model spend low."),
      buildRecord("m2", "preference", "Prefer a minimal frontend ui with simple layout."),
      buildRecord("m3", "artifact", "schema.sql defines the SQLite persistence layer.")
    ]);

    const dbQuery = await store.rankRecords("where is data persisted in storage", { limit: 5 });
    expect(dbQuery[0].record.id).toBe("m3");

    const uiQuery = await store.rankRecords("what color are the layout elements", { limit: 5 });
    expect(uiQuery[0].record.id).toBe("m2");
  });

  it("falls back to lexical-only retrieval when embeddings are disabled", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-semantic-off-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath, embeddingClient: null });

    await store.replaceMemoryRecords([
      buildRecord("m1", "decision", "Adopt Gemini Flash-Lite to keep model spend low.")
    ]);

    // No keyword overlap + no embeddings → no match (proves we didn't silently embed).
    const semantic = await store.rankRecords("budget affordable", { limit: 5 });
    expect(semantic).toHaveLength(0);

    // Lexical query still works.
    const lexical = await store.rankRecords("Gemini", { limit: 5 });
    expect(lexical[0]?.record.id).toBe("m1");
  });
});

function buildRecord(id: string, type: "decision" | "preference" | "artifact", content: string) {
  return {
    id,
    type,
    content,
    normalized: content.toLowerCase(),
    scope: "project" as const,
    status: "active" as const,
    score: { importance: 0.8, confidence: 0.8 },
    source: { kind: "ai_processing" as const },
    entities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
