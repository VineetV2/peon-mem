import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PeonMemoryStore, memoryRecordId } from "../src/memory-store.js";
import { PeonMemoryProcessor } from "../src/processor.js";
import { buildContextInjection } from "../src/injection.js";
import type { ProcessedMemory } from "../src/types.js";

function emptyProcessed(over: Partial<ProcessedMemory> = {}): ProcessedMemory {
  return {
    summary: "",
    decisions: [],
    preferences: [],
    openQuestions: [],
    artifacts: [],
    timeline: [],
    memories: [],
    operations: [],
    ...over
  };
}

async function freshProject(prefix: string): Promise<{ projectPath: string; store: PeonMemoryStore; processor: PeonMemoryProcessor }> {
  const projectPath = await mkdtemp(join(tmpdir(), prefix));
  const store = await PeonMemoryStore.open({ projectPath });
  return { projectPath, store, processor: new PeonMemoryProcessor() };
}

const S1 = "Use OpenRouter for everything.";
const REPLACEMENT = "OpenRouter for chat and processing; embeddings on local Ollama (supersedes the original all-OpenRouter decision).";

describe("provenance", () => {
  test("stamps a canonical source pointer on each belief (no phantom/absolute paths)", async () => {
    const { projectPath, store, processor } = await freshProject("peon-prov-");
    await processor.processMemory({
      projectPath,
      reason: "S1",
      aiResult: emptyProcessed({
        decisions: [
          "Route retries through the durable queue in /Users/x/Project_x 2/peon-mcp/src/daemon.ts.",
          "See the writeup at https://example.com/spec for details."
        ]
      })
    });
    const recs = await store.listMemoryRecords();
    const fileRec = recs.find((r) => r.content.includes("durable queue"));
    expect(fileRec?.provenance?.kind).toBe("file");
    expect(fileRec?.provenance?.ref).toBe("src/daemon.ts"); // canonicalized, not "/Users/..." or "2/..."
    const urlRec = recs.find((r) => r.content.includes("writeup"));
    expect(urlRec?.provenance).toMatchObject({ kind: "url", ref: "https://example.com/spec" });
  });
});

describe("integrative consolidation — the supersession signal", () => {
  test("ACCEPTANCE: a changed belief supersedes the old one and only the current truth is recalled", async () => {
    const { projectPath, store, processor } = await freshProject("peon-accept-");

    // Session 1: record the original decision.
    await processor.processMemory({ projectPath, reason: "S1", aiResult: emptyProcessed({ decisions: [S1] }) });

    const s1Id = memoryRecordId("decision", S1);
    const replacementId = memoryRecordId("decision", REPLACEMENT);

    // Session 6: a supersede operation reconciles the belief that changed.
    await processor.processMemory({
      projectPath,
      reason: "S6",
      aiResult: emptyProcessed({
        operations: [
          { op: "supersede", targetId: s1Id, reason: "embeddings moved to local Ollama", replacement: { type: "decision", content: REPLACEMENT } }
        ]
      })
    });

    const records = await store.listMemoryRecords();
    const old = records.find((r) => r.id === s1Id);
    const replacement = records.find((r) => r.id === replacementId);

    // The old belief is kept but flipped to superseded, linked to its successor.
    expect(old?.status).toBe("superseded");
    expect(old?.supersededBy).toBe(replacementId);
    // The new belief is the active current truth.
    expect(replacement?.status).toBe("active");

    // Default recall returns the current truth and EXCLUDES the superseded belief.
    const ranked = await store.rankRecords("openrouter embeddings ollama");
    const injection = buildContextInjection({ projectResults: ranked, globalRecords: [], query: "openrouter embeddings ollama", maxChars: 6000, includeInactive: false });
    expect(injection.preview).toContain("embeddings on local Ollama");
    expect(injection.preview).not.toContain(S1);
    expect(injection.omitted.some((o) => o.id === s1Id && o.reason === "suppressed_status")).toBe(true);

    // But history is still reachable when explicitly asked for.
    const withHistory = buildContextInjection({ projectResults: ranked, globalRecords: [], query: "openrouter embeddings ollama", maxChars: 6000, includeInactive: true });
    expect(withHistory.preview).toContain(S1);
  });

  test("IDEMPOTENT: replaying the same supersede does not duplicate or re-flip", async () => {
    const { projectPath, store, processor } = await freshProject("peon-idem-");
    await processor.processMemory({ projectPath, reason: "S1", aiResult: emptyProcessed({ decisions: [S1] }) });

    const s1Id = memoryRecordId("decision", S1);
    const supersede = emptyProcessed({
      operations: [{ op: "supersede", targetId: s1Id, replacement: { type: "decision", content: REPLACEMENT } }]
    });

    await processor.processMemory({ projectPath, reason: "first", aiResult: supersede });
    const afterFirst = await store.listMemoryRecords();
    await processor.processMemory({ projectPath, reason: "replay", aiResult: supersede });
    const afterSecond = await store.listMemoryRecords();

    // Same record set after the replay: no duplicate replacement, no second flip.
    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.filter((r) => r.content === REPLACEMENT)).toHaveLength(1);
    expect(afterSecond.find((r) => r.id === s1Id)?.supersededBy).toBe(memoryRecordId("decision", REPLACEMENT));
  });

  test("OBSOLETE: a belief with no successor is retired and dropped from default recall", async () => {
    const { projectPath, store, processor } = await freshProject("peon-obsolete-");
    const question = "Should automatic processing run on every session end?";
    await processor.processMemory({ projectPath, reason: "S1", aiResult: emptyProcessed({ openQuestions: [question] }) });

    const qId = memoryRecordId("open_question", question);
    await processor.processMemory({
      projectPath,
      reason: "resolved",
      aiResult: emptyProcessed({ operations: [{ op: "obsolete", targetId: qId, reason: "resolved in design" }] })
    });

    const record = (await store.listMemoryRecords()).find((r) => r.id === qId);
    expect(record?.status).toBe("superseded");
    expect(record?.supersededBy).toBeUndefined();

    const ranked = await store.rankRecords("automatic processing session end");
    const injection = buildContextInjection({ projectResults: ranked, globalRecords: [], query: "automatic processing session end", maxChars: 6000, includeInactive: false });
    expect(injection.preview).not.toContain(question);
  });

  test("REVIVAL: re-affirming a retired belief brings it back to active and into recall", async () => {
    const { projectPath, store, processor } = await freshProject("peon-revive-");
    const pref = "Prefer local-first storage.";

    // Record it, then retire it via obsolete.
    await processor.processMemory({ projectPath, reason: "S1", aiResult: emptyProcessed({ preferences: [pref] }) });
    const id = memoryRecordId("preference", pref);
    await processor.processMemory({ projectPath, reason: "retire", aiResult: emptyProcessed({ operations: [{ op: "obsolete", targetId: id }] }) });
    expect((await store.listMemoryRecords()).find((r) => r.id === id)?.status).toBe("superseded");

    // Many sessions later the user re-affirms it through the normal add channel.
    await processor.processMemory({ projectPath, reason: "reaffirm", aiResult: emptyProcessed({ preferences: [pref] }) });

    const record = (await store.listMemoryRecords()).find((r) => r.id === id);
    expect(record?.status).toBe("active");          // revived
    expect(record?.supersededBy).toBeUndefined();   // stale link cleared

    const ranked = await store.rankRecords("local-first storage");
    const injection = buildContextInjection({ projectResults: ranked, globalRecords: [], query: "local-first storage", maxChars: 6000, includeInactive: false });
    expect(injection.preview).toContain(pref);      // back in default recall
  });

  test("GRACEFUL: malformed / unanchored operations never corrupt the store", async () => {
    const { projectPath, store, processor } = await freshProject("peon-degrade-");
    await processor.processMemory({ projectPath, reason: "S1", aiResult: emptyProcessed({ decisions: [S1] }) });
    const before = await store.listMemoryRecords();

    await expect(
      processor.processMemory({
        projectPath,
        reason: "garbage",
        aiResult: emptyProcessed({
          operations: [
            // unknown verb → dropped at parse
            { op: "merge", targetId: memoryRecordId("decision", S1) } as never,
            // supersede with empty replacement content → dropped at parse
            { op: "supersede", targetId: memoryRecordId("decision", S1), replacement: { type: "decision", content: "   " } },
            // supersede targeting a non-existent record → dropped at apply (replacement NOT added)
            { op: "supersede", targetId: "mem_decision_doesnotexist", replacement: { type: "decision", content: "Phantom belief that must not be stored." } }
          ]
        })
      })
    ).resolves.toMatchObject({ status: "processed" });

    const after = await store.listMemoryRecords();
    // The original belief is untouched (still active), and no phantom was added.
    expect(after.find((r) => r.id === memoryRecordId("decision", S1))?.status).toBe("active");
    expect(after.some((r) => r.content === "Phantom belief that must not be stored.")).toBe(false);
    expect(after).toHaveLength(before.length);
  });
});
