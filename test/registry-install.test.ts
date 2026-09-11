import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createPeonTools, resolveDaemonUrl } from "../src/tools.js";

/**
 * The MCP registry entry (server.json) and marketplaces that mirror it install Peon as
 *   { "command": "npx", "args": ["-y", "peon-mem"], "env": { "PEON_DAEMON_URL": "your-peon-daemon-url-here" } }
 * `npx -y peon-mem` runs bin/peon-mem.mjs, which printed its help text and exited, so the
 * client got plain text instead of JSON-RPC and every registry install was dead on arrival.
 * The placeholder URL then broke the tools even when a server did start.
 */

const BIN = fileURLToPath(new URL("../bin/peon-mem.mjs", import.meta.url));
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "registry-test", version: "0" } }
};

/** Launch the bin the way an MCP client does (stdin/stdout are pipes) and read the first reply. */
function launchLikeAnMcpClient(args: string[], env: NodeJS.ProcessEnv): Promise<{ firstLine: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no reply within 15s. stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        child.kill();
        resolve({ firstLine: stdout.slice(0, newline), stderr });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timer);
      reject(new Error(`exited ${code} before replying. stdout=${stdout} stderr=${stderr}`));
    });
    child.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
  });
}

function envWithout(name: string): NodeJS.ProcessEnv {
  const { [name]: _omitted, ...rest } = process.env;
  return rest;
}

describe("npx -y peon-mem, launched by an MCP client", () => {
  test("serves MCP over stdio when started with no arguments", async () => {
    const { firstLine } = await launchLikeAnMcpClient([], envWithout("PEON_DAEMON_URL"));
    const reply = JSON.parse(firstLine);
    expect(reply).toMatchObject({ id: 1, result: { serverInfo: { name: "peon-mcp" } } });
  });

  test("serves MCP with the explicit `mcp` subcommand", async () => {
    const { firstLine } = await launchLikeAnMcpClient(["mcp"], envWithout("PEON_DAEMON_URL"));
    expect(JSON.parse(firstLine)).toMatchObject({ id: 1, result: { serverInfo: { name: "peon-mcp" } } });
  });

  test("a copied placeholder PEON_DAEMON_URL is ignored with a warning, not fatal", async () => {
    const { firstLine, stderr } = await launchLikeAnMcpClient([], {
      ...process.env,
      PEON_DAEMON_URL: "your-peon-daemon-url-here"
    });
    expect(JSON.parse(firstLine)).toMatchObject({ id: 1, result: { serverInfo: { name: "peon-mcp" } } });
    expect(stderr).toMatch(/ignoring PEON_DAEMON_URL/);
  });
});

describe("resolveDaemonUrl", () => {
  const quiet = () => {};

  test("keeps real http(s) URLs", () => {
    expect(resolveDaemonUrl("http://127.0.0.1:3737", quiet)).toBe("http://127.0.0.1:3737");
    expect(resolveDaemonUrl(" https://peon.example:8443 ", quiet)).toBe("https://peon.example:8443");
  });

  test("unset or blank means in-process", () => {
    expect(resolveDaemonUrl(undefined, quiet)).toBeUndefined();
    expect(resolveDaemonUrl("   ", quiet)).toBeUndefined();
  });

  test("a placeholder or non-http value is dropped with a warning", () => {
    const warnings: string[] = [];
    expect(resolveDaemonUrl("your-peon-daemon-url-here", (m) => warnings.push(m))).toBeUndefined();
    expect(resolveDaemonUrl("ftp://127.0.0.1:3737", (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/ignoring PEON_DAEMON_URL/);
  });
});

describe("daemon-backed tools when the daemon is down", () => {
  test("say how to start it instead of a bare 'fetch failed'", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-daemon-down-"));
    const tools = createPeonTools({ daemonUrl: "http://127.0.0.1:1" });
    await expect(tools.getContext({ projectPath })).rejects.toThrow(
      /not reachable at http:\/\/127\.0\.0\.1:1[\s\S]*peon-mem install[\s\S]*PEON_DAEMON_URL/
    );
  });
});
