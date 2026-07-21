import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";
import { createPeonTools } from "../src/tools.js";

describe("Peon MCP daemon bridge", () => {
  let daemon: PeonDaemonHandle;
  let projectPath: string;
  let logDir: string;
  let globalMemoryDir: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "peon-bridge-test-"));
    // Isolate daemon state (session index, logs, projects) so the test never
    // picks up real in-flight sessions from the shared global Peon directory.
    logDir = await mkdtemp(join(tmpdir(), "peon-bridge-logs-"));
    globalMemoryDir = await mkdtemp(join(tmpdir(), "peon-bridge-global-"));
    daemon = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir, globalMemoryDir });
  });

  afterEach(async () => {
    await daemon.close();
  });

  test("routes tool calls through the configured daemon", async () => {
    const tools = createPeonTools({ daemonUrl: daemon.url });

    const started = await tools.startSession({ projectPath, client: "bridge-test" });
    const activeSessions = await fetch(`${daemon.url}/sessions`).then((response) => response.json());
    expect(activeSessions.active).toEqual([
      expect.objectContaining({
        id: started.sessionId,
        client: "bridge-test"
      })
    ]);

    await tools.recordMessage({
      sessionId: started.sessionId,
      role: "user",
      content: "MCP adapter should send memory to the local daemon."
    });
    await tools.recordEvent({
      sessionId: started.sessionId,
      type: "decision",
      content: "Daemon bridge is the preferred MCP write path."
    });
    await tools.endSession({ sessionId: started.sessionId });

    const context = await tools.getContext({ projectPath, query: "daemon bridge" });
    // Message appears in timeline; summary is AI-only until processor runs
    expect(context.timeline).toContain("MCP adapter should send memory to the local daemon.");
    expect(context.decisions).toContain("Daemon bridge is the preferred MCP write path.");
  });
});
