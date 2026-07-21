import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import type { MemoryRecord } from "../src/types.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("PeonMemoryStore", () => {
  it("records a session and automatically builds project brain files", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-project-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });

    const session = await store.startSession({ client: "codex", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "We decided to use Gemini Flash-Lite for low-cost memory processing." });
    await store.recordEvent({ sessionId: session.id, type: "decision", content: "Use low-cost non-OpenAI models by default." });
    await store.endSession({ sessionId: session.id });

    const context = await store.getContext({ query: "model preference" });

    // Decision written in real-time to decisions.md — always present without AI processing
    expect(context.decisions).toContain("Use low-cost non-OpenAI models by default.");
    expect(await readFile(join(projectPath, ".peon", "brain", "decisions.md"), "utf8")).toContain("low-cost non-OpenAI");
    // Message is captured in the timeline (summary is AI-only and empty until processor runs)
    expect(context.timeline).toContain("Gemini Flash-Lite");
  });

  it("retrieves over raw episodic turns and blends them into context on request", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-episodes-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "The GPS on the rental was not functioning during the Tahoe trip." });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "We grabbed coffee at Blue Bottle before the drive." });
    await store.endSession({ sessionId: session.id });

    // Episodic ranker surfaces the relevant raw turn (detail consolidation would compress away).
    const episodes = await store.rankEpisodes("GPS not working");
    expect(episodes.length).toBeGreaterThan(0);
    expect(episodes[0].record.content).toContain("GPS");

    // Episodic recall is ON by default (the verbatim layer the belief gist would otherwise lose).
    const byDefault = await store.getContext({ query: "GPS not working" });
    expect(byDefault.episodes).toContain("GPS");
    // ...and can be explicitly turned off.
    const off = await store.getContext({ query: "GPS not working", includeEpisodes: false });
    expect(off.episodes).toBeUndefined();
  });

  it("keeps returned context compact enough for MCP injection", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-project-large-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });

    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordMessage({
      sessionId: session.id,
      role: "user",
      content: "We are building an XO game with local commits."
    });
    await store.recordEvent({
      sessionId: session.id,
      type: "decision",
      content: "Use vanilla HTML/CSS/JS for the XO game."
    });
    await store.recordEvent({
      sessionId: session.id,
      type: "tool_use",
      content: `Tool used: Bash\nInput: ${"x".repeat(8000)}\nOutput: ${"y".repeat(8000)}`
    });
    await store.endSession({ sessionId: session.id });

    const context = await store.getContext({ query: "XO game local commits", maxChars: 5000 });
    const encodedLength = JSON.stringify(context).length;

    expect(encodedLength).toBeLessThan(7000);
    // Message appears in timeline; summary is AI-only until processor runs
    expect(context.timeline).toContain("XO game");
    expect(context.decisions).toContain("vanilla HTML/CSS/JS");
    expect(context.meta?.compacted).toBe(true);
  });

  it("records tool use into the dedicated tool-calls log", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-project-tools-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });

    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordEvent({
      sessionId: session.id,
      type: "tool_use",
      content: "Tool used: Bash\nInput: git status\nOutput: clean"
    });

    const toolCalls = await readFile(join(projectPath, ".peon", "raw", "tool-calls.jsonl"), "utf8");
    expect(toolCalls).toContain("Tool used: Bash");
  });

  it("reads only the delta after the cursor, and falls back to the full window on a lost cursor", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-delta-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });

    // Space the writes a few ms so timestamps are distinct (in real sessions events
    // are seconds/minutes apart; only this fast test could collide within one ms,
    // which would make "newest event" ambiguous across the messages/events files).
    const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
    await tick();
    const m1 = await store.recordMessage({ sessionId: session.id, role: "user", content: "FIRST message." });
    await tick();
    const m2 = await store.recordMessage({ sessionId: session.id, role: "user", content: "SECOND message." });

    // No cursor → everything, newest id reported as the next cursor.
    const all = await store.readRawMemoryDelta(undefined);
    expect(all.text).toContain("FIRST message.");
    expect(all.text).toContain("SECOND message.");
    expect(all.lastEventId).toBe(m2.id);

    // Cursor at m1 → only what came after m1.
    const afterM1 = await store.readRawMemoryDelta(m1.id);
    expect(afterM1.text).not.toContain("FIRST message.");
    expect(afterM1.text).toContain("SECOND message.");

    // Unknown cursor (rotated logs) → safe fallback to the full window, never skips.
    const lost = await store.readRawMemoryDelta("mem-cursor-that-was-rotated-away");
    expect(lost.text).toContain("FIRST message.");
    expect(lost.text).toContain("SECOND message.");
    expect(lost.lastEventId).toBe(m2.id);
  });

  it("caps an oversized delta into chunks and drains across calls (anti truncation-stall)", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-delta-cap-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
    const big = "X".repeat(5000);
    await tick(); const a = await store.recordMessage({ sessionId: session.id, role: "user", content: `AAA ${big}` });
    await tick(); await store.recordMessage({ sessionId: session.id, role: "user", content: `BBB ${big}` });
    await tick(); const c = await store.recordMessage({ sessionId: session.id, role: "user", content: `CCC ${big}` });

    // With an 8k cap, ~15k of delta cannot go in one shot.
    const chunk1 = await store.readRawMemoryDelta(undefined, 8000);
    expect(chunk1.capped).toBe(true);
    expect(chunk1.text.length).toBeLessThanOrEqual(8000);
    expect(chunk1.text).toContain("AAA");
    expect(chunk1.lastEventId).toBe(a.id);        // advanced only to the boundary, NOT the newest
    expect(chunk1.lastEventId).not.toBe(c.id);

    // Feeding the boundary cursor yields the NEXT chunk (draining), not the same text.
    const chunk2 = await store.readRawMemoryDelta(chunk1.lastEventId, 8000);
    expect(chunk2.text).toContain("BBB");
    expect(chunk2.text).not.toContain("AAA");

    // Once the remaining delta fits, capped is false and the cursor reaches the newest event.
    const rest = await store.readRawMemoryDelta(chunk2.lastEventId, 8000);
    expect(rest.capped).toBe(false);
    expect(rest.text).toContain("CCC");
    expect(rest.lastEventId).toBe(c.id);
  });

  it("rejects a path-traversal projectPath (security guard)", async () => {
    await expect(PeonMemoryStore.open({ projectPath: "/Users/x/projects/../../etc/evil" })).rejects.toThrow(/Unsafe projectPath/);
  });

  it("serializes concurrent read-modify-write across TWO store instances (no lost update)", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-concurrency-"));
    dirs.push(projectPath);
    // Two distinct instances on the SAME project — exactly the daemon's situation
    // (cached store + a fresh store opened by the consolidation processor).
    const a = await PeonMemoryStore.open({ projectPath });
    const b = await PeonMemoryStore.open({ projectPath });

    const mk = (id: string, content: string): MemoryRecord => ({
      id, type: "fact", content, normalized: content.toLowerCase(), scope: "project", status: "active",
      score: { importance: 0.5, confidence: 0.6 }, source: { kind: "manual" }, entities: [],
      createdAt: "2026-06-21T00:00:00.000Z", updatedAt: "2026-06-21T00:00:00.000Z"
    });

    // Each transaction reads the full set, appends its own record, and overwrites the file.
    // Without the per-project lock the later writer clobbers the earlier one (classic lost update).
    const txn = (store: PeonMemoryStore, rec: MemoryRecord) =>
      store.runExclusive(async () => {
        const current = await store.listMemoryRecords();
        await store.replaceMemoryRecords([...current, rec]);
      });

    await Promise.all([txn(a, mk("rec-a", "Belief A from instance A.")), txn(b, mk("rec-b", "Belief B from instance B."))]);

    const final = await a.listMemoryRecords();
    const ids = final.map((r) => r.id).sort();
    expect(ids).toEqual(["rec-a", "rec-b"]); // both survive — neither write was lost
  });
});

describe("rankEpisodes lexical prefilter (perf without recall loss)", () => {
  it("still surfaces an OLD verbatim episode that matches the query, past many newer ones", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-epi-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    // one distinctive OLD message, then many newer unrelated ones (the "professor's 3 ideas" shape)
    await store.recordMessage({ sessionId: session.id, role: "user", content: "The professor gave three ideas: quokkatron indexing, zephyr joins, and delta pruning." });
    for (let i = 0; i < 30; i++) {
      await store.recordMessage({ sessionId: session.id, role: "assistant", content: `Unrelated chatter number ${i} about builds and tests.` });
    }
    const hits = await store.rankEpisodes("quokkatron", { limit: 6 });
    expect(hits.some((h) => h.record.content.includes("quokkatron indexing"))).toBe(true);
  });

  it("returns nothing when no episode matches the query (prefilter drops all)", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-epi-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "We discussed database migrations." });
    expect(await store.rankEpisodes("zznonexistenttokenzz", { limit: 6 })).toEqual([]);
  });

  it("with no query falls back to recent episodes (not empty)", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-epi-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "A recent conversational turn worth recalling." });
    expect((await store.rankEpisodes(undefined, { limit: 6 })).length).toBeGreaterThan(0);
  });
});
