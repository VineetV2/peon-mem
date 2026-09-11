import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PeonLogger } from "../src/logger.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("PeonLogger best-effort writes", () => {
  test("logs round-trip through recent() and redact secrets", async () => {
    const logDir = tempDir("peon-logger-ok-");
    const logger = new PeonLogger({ logDir });

    await logger.log("request_in", { path: "/sessions", apiKey: "sk-live-shouldhide" });
    const recent = await logger.recent(10);

    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe("request_in");
    expect(recent[0].apiKey).toBe("[redacted]");
  });

  test("a write failure never rejects — logging is best-effort", async () => {
    // Point the logger at a directory path that is actually a regular file, so
    // mkdir()/appendFile() inside enqueueWrite always reject.
    const base = tempDir("peon-logger-fail-");
    const blocker = join(base, "blocker");
    writeFileSync(blocker, "i am a file, not a directory", "utf8");
    const logger = new PeonLogger({ logDir: blocker });

    // Repeated logging must resolve every time and never throw.
    await expect(
      Promise.all([
        logger.log("a"),
        logger.log("b", { detail: "x" }),
        logger.log("c")
      ])
    ).resolves.toBeDefined();

    // And reading back degrades to an empty list rather than throwing.
    await expect(logger.recent()).resolves.toEqual([]);
  });
});

describe("PeonLogger bounded reads and rotation", () => {
  test("recent() reads only the tail — entries beyond the window are not scanned", async () => {
    const logDir = tempDir("peon-logger-tail-");
    const logger = new PeonLogger({ logDir });

    // ~40 MB of history: the shape that wedged the daemon's event loop when
    // recent() slurped and split the whole file on every poll.
    const filler = "x".repeat(2000);
    const lines: string[] = [];
    // A perfectly valid entry buried at the very START of a huge file. A
    // full-file reader would happily return it; a bounded tail reader must not
    // even look that far back.
    lines.push(JSON.stringify({ id: "ancient", type: "ancient", createdAt: new Date().toISOString() }));
    for (let i = 0; i < 20000; i += 1) {
      lines.push(JSON.stringify({ id: `old-${i}`, type: "filler", createdAt: new Date().toISOString(), filler }));
    }
    for (let i = 0; i < 5; i += 1) {
      lines.push(JSON.stringify({ id: `recent-${i}`, type: "wanted", createdAt: new Date().toISOString() }));
    }
    writeFileSync(join(logDir, "daemon.jsonl"), lines.join("\n") + "\n", "utf8");

    const recent = await logger.recent(5);
    expect(recent.map((e) => e.id)).toEqual(["recent-4", "recent-3", "recent-2", "recent-1", "recent-0"]);

    // Even asked for far more than the file holds, the read stays bounded: the
    // entry beyond the tail window is never returned.
    const greedy = await logger.recent(1_000_000);
    expect(greedy.some((e) => e.id === "ancient")).toBe(false);
  });

  test("recent() still returns everything when the log is smaller than the tail window", async () => {
    const logDir = tempDir("peon-logger-small-");
    const logger = new PeonLogger({ logDir });
    await logger.log("first");
    await logger.log("second");

    const recent = await logger.recent(10);
    expect(recent.map((e) => e.type)).toEqual(["second", "first"]);
  });

  test("a partial first line from a mid-line tail seek is discarded, not parsed", async () => {
    const logDir = tempDir("peon-logger-partial-");
    const logger = new PeonLogger({ logDir });
    // Truncated JSON at the head simulates seeking into the middle of a line.
    writeFileSync(
      join(logDir, "daemon.jsonl"),
      '{"id":"trunc","ty\n' + JSON.stringify({ id: "good", type: "ok", createdAt: new Date().toISOString() }) + "\n",
      "utf8"
    );

    const recent = await logger.recent(10);
    expect(recent.map((e) => e.id)).toEqual(["good"]);
  });

  test("the log rotates instead of growing without bound", async () => {
    const logDir = tempDir("peon-logger-rotate-");
    const logger = new PeonLogger({ logDir, maxBytes: 4096 });
    const logFile = join(logDir, "daemon.jsonl");

    for (let i = 0; i < 300; i += 1) {
      await logger.log("spam", { i, pad: "y".repeat(200) });
    }

    // Live file is kept under control...
    expect(statSync(logFile).size).toBeLessThanOrEqual(4096 * 2);
    // ...and history is preserved in a rotated sibling, never silently dropped.
    const rotated = readdirSync(logDir).filter((f) => f.startsWith("daemon.jsonl.") );
    expect(rotated.length).toBeGreaterThan(0);
    // Most recent writes survive rotation and are still readable.
    const recent = await logger.recent(5);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0].type).toBe("spam");
  });
});

describe("PeonLogger tail window vs real callers", () => {
  test("the tail window covers the daemon's largest read (50k entries for token stats)", async () => {
    const logDir = tempDir("peon-logger-seed-");
    const logger = new PeonLogger({ logDir });

    // Mirrors the real log shape: ~260 bytes/entry, 50k entries requested by
    // seedTokenStats() on boot. Bounding reads must not silently shrink this.
    const lines: string[] = [];
    for (let i = 0; i < 50000; i += 1) {
      lines.push(
        JSON.stringify({
          id: `e-${i}`,
          type: "process_finish",
          createdAt: new Date().toISOString(),
          projectPath: "/Users/someone/Documents/a-project",
          model: "google/gemini-2.5-flash-lite",
          tokens: 700,
          status: "processed"
        })
      );
    }
    writeFileSync(join(logDir, "daemon.jsonl"), lines.join("\n") + "\n", "utf8");

    const entries = await logger.recent(50000);
    // Allow a small shortfall for the discarded partial first line, but the
    // window must not clip this down to a fraction of what was asked for.
    expect(entries.length).toBeGreaterThan(49900);
    expect(entries[0].id).toBe("e-49999");
  });
});
