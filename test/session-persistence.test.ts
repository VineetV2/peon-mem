import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";
import { SessionIndex } from "../src/session-index.js";
import { createPeonTools } from "../src/tools.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status >= 300) throw new Error(`${url} -> ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

describe("durable sessions (in-process tools)", () => {
  test("a fresh tools instance can still record into a session started before restart", async () => {
    const projectPath = tempDir("peon-persist-proj-");
    const stateDir = tempDir("peon-persist-state-");
    const sessionIndexPath = join(stateDir, "sessions-index.json");

    // First "process": start a session and record a message.
    const tools1 = createPeonTools({ sessionIndexPath });
    const { sessionId } = await tools1.startSession({ projectPath, client: "claude-code" });
    await tools1.recordMessage({ sessionId, role: "user", content: "Message before the restart." });

    // Simulate a daemon restart: brand-new tools instance, no shared memory,
    // pointing at the same on-disk session index.
    const tools2 = createPeonTools({ sessionIndexPath });

    // Before the fix this threw "Unknown Peon session".
    await expect(
      tools2.recordMessage({ sessionId, role: "user", content: "Message after the restart." })
    ).resolves.toBeDefined();
    await tools2.recordEvent({ sessionId, type: "decision", content: "Survive daemon restarts." });
    const ended = await tools2.endSession({ sessionId });
    expect(ended.endedAt).toBeDefined();

    const context = await tools2.getContext({ projectPath });
    expect(context.timeline).toContain("Message before the restart.");
    expect(context.timeline).toContain("Message after the restart.");
    expect(context.decisions).toContain("Survive daemon restarts.");
  });

  test("ending a session removes it from the durable index", async () => {
    const projectPath = tempDir("peon-persist-proj-");
    const stateDir = tempDir("peon-persist-state-");
    const sessionIndexPath = join(stateDir, "sessions-index.json");

    const tools = createPeonTools({ sessionIndexPath });
    const { sessionId } = await tools.startSession({ projectPath, client: "claude-code" });

    const index = new SessionIndex(sessionIndexPath);
    expect(await index.get(sessionId)).toBeDefined();

    await tools.endSession({ sessionId });
    expect(await new SessionIndex(sessionIndexPath).get(sessionId)).toBeUndefined();
  });

  test("still rejects genuinely unknown sessions", async () => {
    const stateDir = tempDir("peon-persist-state-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });
    await expect(
      tools.recordMessage({ sessionId: "does-not-exist", role: "user", content: "x" })
    ).rejects.toThrow(/Unknown Peon session/);
  });
});

describe("durable sessions (daemon HTTP, across a real restart)", () => {
  let daemon: PeonDaemonHandle | undefined;

  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  test("a restarted daemon resolves and finalizes a session started by the previous one", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-persist-httpproj-"));
    const logDir = tempDir("peon-persist-httplog-");
    const globalMemoryDir = tempDir("peon-persist-httpglobal-");
    dirs.push(projectPath);

    // First daemon starts a session and records a message.
    const first = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir, globalMemoryDir });
    const { sessionId } = await postJson<{ sessionId: string }>(`${first.url}/sessions`, {
      projectPath,
      client: "claude-code"
    });
    await postJson(`${first.url}/messages`, { sessionId, role: "user", content: "Recorded by daemon one." });
    await first.close();

    // Second daemon boots from the same state dir.
    const second = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir, globalMemoryDir });
    daemon = second;

    // The rehydrated session shows up in the monitor's active list.
    const active = await fetch(`${second.url}/sessions`).then((response) => response.json());
    expect(active.active).toEqual([expect.objectContaining({ id: sessionId, client: "claude-code" })]);

    // And it can still be written to + ended.
    await postJson(`${second.url}/messages`, { sessionId, role: "user", content: "Recorded by daemon two." });
    await postJson(`${second.url}/sessions/${encodeURIComponent(sessionId)}/end`, {});

    const context = await fetch(
      `${second.url}/context?projectPath=${encodeURIComponent(projectPath)}`
    ).then((response) => response.json());
    expect(context.timeline).toContain("Recorded by daemon one.");
    expect(context.timeline).toContain("Recorded by daemon two.");

    // The per-session summary is rebuilt from disk on end, so it must contain BOTH
    // the pre-restart and post-restart events — this is the core rehydration path.
    const summary = await readFile(join(projectPath, ".peon", "sessions", `${sessionId}.md`), "utf8");
    expect(summary).toContain("Recorded by daemon one.");
    expect(summary).toContain("Recorded by daemon two.");
  });
});

describe("session summary isolation", () => {
  test("a session's summary contains only its own events, not a sibling session's", async () => {
    const projectPath = tempDir("peon-isolation-proj-");
    const stateDir = tempDir("peon-isolation-state-");
    const tools = createPeonTools({ sessionIndexPath: join(stateDir, "sessions-index.json") });

    // Two concurrent sessions in the SAME project (same memory store).
    const a = await tools.startSession({ projectPath, client: "session-a" });
    const b = await tools.startSession({ projectPath, client: "session-b" });
    await tools.recordMessage({ sessionId: a.sessionId, role: "user", content: "ALPHA-only event." });
    await tools.recordMessage({ sessionId: b.sessionId, role: "user", content: "BETA-only event." });
    await tools.endSession({ sessionId: a.sessionId });

    const summaryA = await readFile(join(projectPath, ".peon", "sessions", `${a.sessionId}.md`), "utf8");
    expect(summaryA).toContain("ALPHA-only event.");
    // The sessionId filter must keep the sibling's event out of A's summary.
    expect(summaryA).not.toContain("BETA-only event.");
  });
});

describe("SessionIndex corruption recovery", () => {
  test("a corrupt index resolves to empty without throwing and self-heals on next write", async () => {
    const stateDir = tempDir("peon-corrupt-state-");
    const indexPath = join(stateDir, "sessions-index.json");
    writeFileSync(indexPath, "{ this is not valid json", "utf8");

    const index = new SessionIndex(indexPath);
    // Reads degrade gracefully rather than blocking all session resolution.
    await expect(index.active()).resolves.toEqual([]);
    await expect(index.get("anything")).resolves.toBeUndefined();

    // A subsequent write cleanly overwrites the corrupt file.
    await index.set({
      sessionId: "recovered",
      projectPath: "/p",
      client: "c",
      cwd: "/p",
      startedAt: "2026-06-05T00:00:00.000Z"
    });
    const reloaded = new SessionIndex(indexPath);
    expect(await reloaded.get("recovered")).toBeDefined();
  });

  test("index entries with missing fields are ignored, not loaded as sessions", async () => {
    const stateDir = tempDir("peon-partial-state-");
    const indexPath = join(stateDir, "sessions-index.json");
    // Valid JSON object, but the value is missing required fields.
    writeFileSync(indexPath, JSON.stringify({ broken: { sessionId: "broken" } }), "utf8");

    const index = new SessionIndex(indexPath);
    await expect(index.active()).resolves.toEqual([]);
  });
});

describe("SessionIndex.prune", () => {
  test("drops sessions older than the max age and keeps fresh ones", async () => {
    const stateDir = tempDir("peon-prune-state-");
    const index = new SessionIndex(join(stateDir, "sessions-index.json"));
    const now = Date.parse("2026-06-05T00:00:00.000Z");

    await index.set({
      sessionId: "old",
      projectPath: "/p",
      client: "c",
      cwd: "/p",
      startedAt: "2026-06-01T00:00:00.000Z"
    });
    await index.set({
      sessionId: "fresh",
      projectPath: "/p",
      client: "c",
      cwd: "/p",
      startedAt: "2026-06-04T23:00:00.000Z"
    });

    const removed = await index.prune(now, 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(await index.get("old")).toBeUndefined();
    expect(await index.get("fresh")).toBeDefined();
  });
});
