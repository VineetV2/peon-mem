import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { compressTopicClusters } from "../src/brain.js";
import { resetBrainPassGate, setBrainPassIdleWindow } from "../src/brain-pass-gate.js";
import { loadPeonConfig } from "../src/config.js";
import type { EmbeddingClient } from "../src/embeddings.js";
import { PeonGlobalMemoryStore } from "../src/global-memory.js";
import { PeonMemoryStore } from "../src/memory-store.js";
import { ensureUniqueRecordIds } from "../src/record-ids.js";
import type { MemoryRecord } from "../src/types.js";

/**
 * Measured on the live daemon (2026-09-15): every 3-minute brain pulse on a 32k-memory brain
 * re-embedded the same 912 memories (209-237 s of model-server time, write lock held), because
 * 220 compression-summary ids were shared by several summaries of the same topic. Idle brains
 * were also re-read, rewritten and snapshotted on every pulse, and the global brain kept every
 * snapshot: 24,037 files, 17 GB.
 */

const NOW = "2026-09-15T00:00:00.000Z";
function rec(over: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "r", type: "decision", content: "c", normalized: "c", scope: "project", status: "active",
    score: { importance: 0.6, confidence: 0.8 }, source: { kind: "ai_processing" }, entities: [],
    createdAt: NOW, updatedAt: NOW, ...over
  };
}
const pause = () => new Promise((r) => setTimeout(r, 15));
const localConfig = () => loadPeonConfig({ PEON_EMBEDDING_MODE: "local" });

beforeEach(() => resetBrainPassGate());
afterEach(() => vi.restoreAllMocks());

describe("summary ids", () => {
  test("a summary id depends on its content, so recompressing a topic never reuses an old summary's id", async () => {
    const members = Array.from({ length: 5 }, (_, i) => rec({ id: `m${i}`, content: `dc fact ${i}`, entities: ["dc"] }));
    const makeId = vi.fn((entity: string, content: string) => `sum_${entity}_${content.length}_${content.at(-1)}`);
    const first = await compressTopicClusters(members, async () => "dc summary one", NOW, { makeId });
    const second = await compressTopicClusters(members, async () => "dc summary two", NOW, { makeId });
    expect(makeId).toHaveBeenCalledWith("dc", "dc summary one");
    const summaryId = (r: { records: MemoryRecord[] }) => r.records.find((x) => x.type === "summary")!.id;
    expect(summaryId(first)).not.toBe(summaryId(second));
  });
});

describe("ensureUniqueRecordIds", () => {
  test("leaves unique ids untouched", () => {
    const out = ensureUniqueRecordIds([rec({ id: "a" }), rec({ id: "b" })]);
    expect(out.reassigned).toBe(0);
    expect(out.records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("the live copy keeps a shared id; retired copies get distinct, stable ids and their members follow", () => {
    const records = [
      rec({ id: "sum", type: "summary", content: "old summary", status: "superseded", summaryOf: ["m1"], updatedAt: "2026-09-01T00:00:00.000Z" }),
      rec({ id: "m1", status: "archived", summarizedBy: "sum" }),
      rec({ id: "sum", type: "summary", content: "new summary", status: "active", summaryOf: ["m2"] }),
      rec({ id: "m2", status: "archived", summarizedBy: "sum" }),
      rec({ id: "sum", type: "summary", content: "older summary", status: "archived", summaryOf: [], updatedAt: "2026-08-01T00:00:00.000Z" })
    ];
    const out = ensureUniqueRecordIds(records);
    const ids = out.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.reassigned).toBe(2);
    expect(out.records.find((r) => r.content === "new summary")!.id).toBe("sum");
    const oldId = out.records.find((r) => r.content === "old summary")!.id;
    expect(oldId).not.toBe("sum");
    expect(out.records.find((r) => r.id === "m1")!.summarizedBy).toBe(oldId);
    expect(out.records.find((r) => r.id === "m2")!.summarizedBy).toBe("sum");
    expect(ensureUniqueRecordIds(records).records.map((r) => r.id)).toEqual(ids); // deterministic
    expect(records[0].id).toBe("sum"); // input is not mutated
  });
});

describe("a project brain pass", () => {
  test("heals duplicate ids, so the same memories are not re-embedded on every pass", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-dupids-"));
    const asked: string[] = [];
    const client: EmbeddingClient = {
      model: "count-test",
      async embed(texts) {
        asked.push(...texts);
        return texts.map((t) => { const v = new Array(8).fill(0); v[t.length % 8] = 1; return v; });
      }
    };
    const store = await PeonMemoryStore.open({ projectPath, config: localConfig(), embeddingClient: client });
    await store.replaceMemoryRecords([
      rec({ id: "sum", type: "summary", content: "new summary", status: "active" }),
      rec({ id: "sum", type: "summary", content: "old summary", status: "superseded" }),
      rec({ id: "x", content: "an unrelated decision" })
    ]);
    const ids = (await store.listMemoryRecords()).map((r) => r.id);
    expect(new Set(ids).size).toBe(3);

    await store.runBrainPass({ recalledIds: ["x"] });
    asked.length = 0;
    await pause();
    await store.runBrainPass({ recalledIds: ["x"] });
    expect(asked).toEqual([]);
  });

  async function seeded() {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-idle-"));
    const store = await PeonMemoryStore.open({ projectPath, config: localConfig(), embeddingClient: null });
    await store.replaceMemoryRecords([rec({ id: "a", content: "decision a" }), rec({ id: "b", content: "decision b" })]);
    const brain = join(projectPath, ".peon", "brain");
    return { store, memories: join(brain, "memories.jsonl"), backups: join(brain, "backups") };
  }
  const count = async (dir: string) => (await readdir(dir).catch(() => [])).length;

  test("over a brain that has not changed since the last pass does nothing: no rewrite, no snapshot", async () => {
    const { store, memories, backups } = await seeded();
    await store.runBrainPass({});
    const mtime = (await stat(memories)).mtimeMs;
    const snapshots = await count(backups);
    await pause();
    expect(await store.runBrainPass({})).toEqual([]);
    expect((await stat(memories)).mtimeMs).toBe(mtime);
    expect(await count(backups)).toBe(snapshots);
  });

  test("runs again when memories were recalled, the brain was written, or the idle window elapsed", async () => {
    const { store, backups } = await seeded();
    await store.runBrainPass({});
    await pause();

    let before = await count(backups);
    await store.runBrainPass({ recalledIds: ["a"] });
    expect(await count(backups)).toBe(before + 1);
    await pause();

    await store.replaceMemoryRecords([...(await store.listMemoryRecords()), rec({ id: "c", content: "decision c" })]);
    await pause();
    before = await count(backups);
    await store.runBrainPass({});
    expect(await count(backups)).toBe(before + 1);
    await pause();

    setBrainPassIdleWindow(0);
    before = await count(backups);
    await store.runBrainPass({});
    expect(await count(backups)).toBe(before + 1);
  });
});

describe("global brain backups", () => {
  const snapshots = async (dir: string) => (await readdir(join(dir, "backups")).catch(() => [])).filter((f) => f.startsWith("memories-"));
  async function conflicted(globalDir: string) {
    const store = await PeonGlobalMemoryStore.open({ globalDir });
    await store.append({ type: "fact", content: "The cluster login host is enabled", scope: "global", importance: 0.7, confidence: 0.9, entities: ["cluster"] });
    await store.append({ type: "fact", content: "The cluster login host is disabled", scope: "global", importance: 0.7, confidence: 0.3, entities: ["cluster"] });
    return store;
  }
  async function withOldSnapshots(n: number) {
    const globalDir = await mkdtemp(join(tmpdir(), "peon-global-snap-"));
    await mkdir(join(globalDir, "backups"), { recursive: true });
    for (let i = 0; i < n; i += 1) {
      await writeFile(join(globalDir, "backups", `memories-2026-01-01T00-00-${String(i).padStart(3, "0")}Z.jsonl`), "");
    }
    return globalDir;
  }

  test("a pass that changes nothing writes no snapshot", async () => {
    const globalDir = await mkdtemp(join(tmpdir(), "peon-global-snap-"));
    const store = await PeonGlobalMemoryStore.open({ globalDir });
    await store.append({ type: "fact", content: "The user runs Ollama on an M1", scope: "global", importance: 0.7, confidence: 0.9, entities: ["m1"] });
    expect(await store.runBrainPass()).toEqual([]);
    expect(await snapshots(globalDir)).toHaveLength(0);
  });

  test("keeps the newest 20 snapshots", async () => {
    const globalDir = await withOldSnapshots(25);
    const store = await conflicted(globalDir);
    expect((await store.runBrainPass()).length).toBeGreaterThan(0);
    const left = await snapshots(globalDir);
    expect(left).toHaveLength(20);
    expect(left).not.toContain("memories-2026-01-01T00-00-000Z.jsonl");
  });

  test("never mass-deletes a large historical pile; warns instead", async () => {
    const globalDir = await withOldSnapshots(150);
    const store = await conflicted(globalDir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.runBrainPass();
    expect(await snapshots(globalDir)).toHaveLength(151);
    expect(warn.mock.calls.some((c) => /backups/i.test(String(c[0])))).toBe(true);
  });
});
