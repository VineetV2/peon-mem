import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";

/**
 * The daemon refuses browser requests from other sites. The Origin/Referer check covers
 * POSTs, but an <img src="http://127.0.0.1:3737/context?projectPath=..."> on a page with
 * referrerpolicy="no-referrer" sends neither header, and GET /context still opens (and so
 * CREATES) a brain at that path. Browsers do label that request Sec-Fetch-Site: cross-site.
 */
describe("daemon request guard: cross-site browser requests", () => {
  let daemon: PeonDaemonHandle;
  let victimDir: string;

  beforeEach(async () => {
    victimDir = await mkdtemp(join(tmpdir(), "peon-guard-victim-"));
    const logDir = await mkdtemp(join(tmpdir(), "peon-guard-logs-"));
    const globalMemoryDir = await mkdtemp(join(tmpdir(), "peon-guard-global-"));
    daemon = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir, globalMemoryDir });
  });

  afterEach(async () => {
    await daemon.close();
  });

  const contextUrl = () => `${daemon.url}/context?projectPath=${encodeURIComponent(victimDir)}`;
  /** What a no-referrer <img> on another site sends: no Origin, no Referer. */
  const crossSiteImage = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };

  test("refuses a cross-site subresource GET and creates no brain", async () => {
    const response = await fetch(contextUrl(), { headers: crossSiteImage });
    expect(response.status).toBe(403);
    expect(existsSync(join(victimDir, ".peon"))).toBe(false);
  });

  test("refuses a cross-site POST even without Origin or Referer", async () => {
    const response = await fetch(`${daemon.url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ projectPath: victimDir, client: "drive-by" })
    });
    expect(response.status).toBe(403);
    expect(existsSync(join(victimDir, ".peon"))).toBe(false);
  });

  test.each([
    ["the monitor UI's own requests", { "sec-fetch-site": "same-origin" }],
    ["opening the monitor from the address bar or a bookmark", { "sec-fetch-site": "none" }],
    ["another localhost port, like a loopback Origin", { "sec-fetch-site": "same-site" }],
    ["the hook, MCP server and curl (no Sec-Fetch headers)", {}]
  ])("allows %s", async (_label, headers) => {
    const response = await fetch(contextUrl(), { headers });
    expect(response.status).toBe(200);
  });
});
