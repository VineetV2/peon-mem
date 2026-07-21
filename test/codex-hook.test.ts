import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";

describe("Codex Peon hook wrapper", () => {
  let daemon: PeonDaemonHandle;
  let projectPath: string;
  let stateDir: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "peon-codex-hook-project-"));
    stateDir = await mkdtemp(join(tmpdir(), "peon-codex-hook-state-"));
    daemon = await startPeonDaemon({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await daemon.close();
    await rm(projectPath, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  test("records Codex user prompts with Codex client metadata", async () => {
    await runCodexHook({
      event: "user_prompt_submit",
      sessionId: "codex-session",
      cwd: projectPath,
      prompt: [{ text: "Capture this Codex prompt." }]
    });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    const events = await readFile(join(projectPath, ".peon/raw/events.jsonl"), "utf8");
    expect(messages).toContain("Capture this Codex prompt.");
    expect(events).toContain("Session started for codex");
  });

  async function runCodexHook(input: unknown): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("node", ["scripts/codex-peon-hook.mjs"], {
        cwd: "/Users/vora/Documents/Project_x 2/peon-mcp",
        env: {
          ...process.env,
          PEON_DAEMON_URL: daemon.url,
          PEON_HOOK_STATE_DIR: stateDir
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Hook exited with code ${code}`));
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
});
