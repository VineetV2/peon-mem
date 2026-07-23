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
  it("detects Cline and targets its shared MCP settings file", () => {
    const home = mkdtempSync(join(tmpdir(), "peon-installer-"));
    temporaryHomes.push(home);
    mkdirSync(join(home, ".cline", "data", "settings"), { recursive: true });

    const output = execFileSync(
      process.execPath,
      [installer, "install", "--yes", "--dry-run"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PEON_FORCE_PLATFORM: "linux",
        },
      },
    );

    expect(output).toContain("Cline");
    expect(output).toContain(
      join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    );
    expect(output).toContain("mcpServers.peon");
  });
});
