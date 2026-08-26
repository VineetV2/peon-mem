import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const installer = fileURLToPath(new URL("../bin/peon-mem.mjs", import.meta.url));
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("guided installer app detection", () => {
  function runInstaller(home: string, platform: "darwin" | "linux") {
    return execFileSync(
      process.execPath,
      [installer, "install", "--yes", "--dry-run"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PEON_FORCE_PLATFORM: platform,
        },
      },
    );
  }

  it.each([
    ["linux", [".config", "Code", "User"]],
    ["darwin", ["Library", "Application Support", "Code", "User"]],
  ] as const)("prefers the Cline VS Code extension settings on %s", (platform, codeUser) => {
    const home = mkdtempSync(join(tmpdir(), "peon-installer-"));
    temporaryHomes.push(home);
    const extensionFile = join(
      home,
      ...codeUser,
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
    mkdirSync(join(extensionFile, ".."), { recursive: true });
    mkdirSync(join(home, ".cline", "data", "settings"), { recursive: true });

    const output = runInstaller(home, platform);

    expect(output).toContain("Cline");
    expect(output).toContain(extensionFile);
    expect(output).not.toContain(
      join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    );
    expect(output).toContain("mcpServers.peon");
  });

  it("falls back to the Cline CLI settings", () => {
    const home = mkdtempSync(join(tmpdir(), "peon-installer-"));
    temporaryHomes.push(home);
    const cliFile = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    mkdirSync(join(cliFile, ".."), { recursive: true });

    const output = runInstaller(home, "linux");

    expect(output).toContain("Cline");
    expect(output).toContain(cliFile);
    expect(output).toContain("mcpServers.peon");
  });
});
