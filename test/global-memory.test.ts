import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PeonGlobalMemoryStore } from "../src/global-memory.js";
import type { MemoryRecord } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempGlobalDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "peon-global-memory-"));
  dirs.push(dir);
  return dir;
}

describe("PeonGlobalMemoryStore", () => {
  it("uses the Peon application support global directory by default", () => {
    expect(PeonGlobalMemoryStore.defaultDirectory()).toBe(
      "/Users/vora/Library/Application Support/Peon/global"
    );
  });

  it("appends global memory records and persists them as JSONL", async () => {
    const globalDir = tempGlobalDir();
    const store = await PeonGlobalMemoryStore.open({ globalDir });

    const record = await store.append({
      type: "preference",
      content: "Prefer concise engineering updates.",
      scope: "global",
      importance: 0.8,
      confidence: 0.9,
      entities: ["Codex"]
    });

    expect(record).toMatchObject({
      type: "preference",
      content: "Prefer concise engineering updates.",
      normalized: "prefer concise engineering updates",
      scope: "global",
      status: "active",
      score: {
        importance: 0.8,
        confidence: 0.9
      },
      source: {
        kind: "manual"
      },
      entities: ["Codex"]
    });

    const raw = await readFile(join(globalDir, "memories.jsonl"), "utf8");
    const lines = raw.trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(record);

    const reloaded = await PeonGlobalMemoryStore.open({ globalDir });
    expect(await reloaded.list()).toEqual([record]);
  });

  it("upserts matching records by type and normalized content", async () => {
    const store = await PeonGlobalMemoryStore.open({ globalDir: tempGlobalDir() });

    const created = await store.upsert({
      type: "preference",
      content: "Use Vitest for MCP package tests.",
      scope: "global",
      confidence: 0.4,
      entities: ["Vitest"]
    });
    const updated = await store.upsert({
      type: "preference",
      content: "Use vitest for MCP package tests!",
      scope: "global",
      importance: 0.95,
      confidence: 0.85,
      entities: ["MCP"]
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(updated.content).toBe("Use vitest for MCP package tests!");
    expect(updated.score).toEqual({
      importance: 0.95,
      confidence: 0.85
    });
    expect(updated.entities).toEqual(["Vitest", "MCP"]);
    expect(await store.list()).toHaveLength(1);
  });

  it("lists and searches active global records by relevance", async () => {
    const store = await PeonGlobalMemoryStore.open({ globalDir: tempGlobalDir() });
    await store.append({
      type: "fact",
      content: "The user prefers pnpm for frontend work.",
      scope: "global",
      importance: 0.6
    });
    await store.append({
      type: "decision",
      content: "Keep Peon AI processing behind a cost gate.",
      scope: "global",
      importance: 0.9
    });
    await store.append({
      type: "preference",
      content: "Avoid verbose final responses unless requested.",
      scope: "global",
      status: "stale"
    });

    expect((await store.list()).map((record) => record.content)).toEqual([
      "Keep Peon AI processing behind a cost gate.",
      "The user prefers pnpm for frontend work.",
      "Avoid verbose final responses unless requested."
    ]);
    expect((await store.search("frontend pnpm")).map((record) => record.content)).toEqual([
      "The user prefers pnpm for frontend work."
    ]);
    expect(await store.list({ status: "active", type: "decision" })).toEqual([
      expect.objectContaining({ content: "Keep Peon AI processing behind a cost gate." })
    ]);
  });

  it("curates the global brain itself — resolves conflicts among shared beliefs", async () => {
    const store = await PeonGlobalMemoryStore.open({ globalDir: tempGlobalDir() });
    await store.append({ type: "fact", content: "The cluster login host is enabled", scope: "global", importance: 0.7, confidence: 0.9, entities: ["cluster"] });
    await store.append({ type: "fact", content: "The cluster login host is disabled", scope: "global", importance: 0.7, confidence: 0.3, entities: ["cluster"] });

    const actions = await store.runBrainPass();
    expect(actions.some((a) => a.type === "resolve_conflict")).toBe(true);
    // Global beliefs are the working set here — the loser is archived, not protected.
    const active = await store.list({ status: "active" });
    expect(active.map((r) => r.content)).toContain("The cluster login host is enabled");
    expect(active.map((r) => r.content)).not.toContain("The cluster login host is disabled");
  });

  it("imports only project memory records marked with global scope", async () => {
    const store = await PeonGlobalMemoryStore.open({ globalDir: tempGlobalDir() });
    const now = new Date().toISOString();
    const records: MemoryRecord[] = [
      {
        id: "project-global-1",
        type: "preference",
        content: "Remember the user prefers short status updates.",
        normalized: "remember the user prefers short status updates",
        scope: "global",
        status: "active",
        score: { importance: 0.7, confidence: 0.8 },
        source: { kind: "ai_processing", reason: "project-import" },
        entities: ["user"],
        createdAt: now,
        updatedAt: now
      },
      {
        id: "project-local-1",
        type: "decision",
        content: "This project uses a private memory store.",
        normalized: "this project uses a private memory store",
        scope: "project",
        status: "active",
        score: { importance: 0.9, confidence: 0.8 },
        source: { kind: "ai_processing" },
        entities: [],
        createdAt: now,
        updatedAt: now
      }
    ];

    const imported = await store.importGlobalRecords(records, { reason: "processor-export" });

    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      type: "preference",
      content: "Remember the user prefers short status updates.",
      scope: "global",
      source: {
        kind: "ai_processing",
        reason: "processor-export"
      }
    });
    expect(await store.list()).toHaveLength(1);
    expect((await store.search("private memory store"))).toHaveLength(0);
  });
});
