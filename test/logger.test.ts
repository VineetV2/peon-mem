import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
