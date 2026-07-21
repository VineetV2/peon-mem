import { describe, expect, it } from "vitest";
import { buildInstallPlan, parseInstallArgs } from "../scripts/install-peon.mjs";

describe("install-peon planner", () => {
  it("parses supported non-destructive modes", () => {
    expect(parseInstallArgs(["--json"], "/repo")).toMatchObject({
      output: "json",
      action: "dry-run",
      projectPath: "/repo"
    });
    expect(parseInstallArgs(["--check", "/workspace/app"], "/repo")).toMatchObject({
      output: "text",
      action: "check",
      projectPath: "/workspace/app"
    });
    expect(parseInstallArgs(["--write-plan"], "/repo")).toMatchObject({
      output: "text",
      action: "write-plan",
      projectPath: "/repo"
    });
  });

  it("builds a complete install plan without install side effects", () => {
    const plan = buildInstallPlan({
      projectPath: "/workspace/app",
      packageDir: "/repo/peon-mcp",
      repoDir: "/repo",
      daemonUrl: "http://127.0.0.1:3737",
      checks: {
        packageDir: true,
        builtDaemon: false,
        builtMcpServer: true,
        claudeHook: true,
        projectMemoryDir: false
      }
    });

    expect(plan.mode).toBe("dry-run");
    expect(plan.nonDestructive).toBe(true);
    expect(plan.paths).toMatchObject({
      daemonBin: "/repo/peon-mcp/dist/daemon-cli.js",
      mcpBin: "/repo/peon-mcp/dist/index.js",
      claudeHook: "/repo/peon-mcp/scripts/claude-peon-hook.mjs",
      memoryDir: "/workspace/app/.peon"
    });
    expect(plan.launchctl.label).toBe("com.peon.daemon");
    expect(plan.claude.mcpConfigSnippet.mcpServers.peon.command).toBe("node");
    expect(plan.claude.hookCommandSnippet).toContain("claude-peon-hook.mjs");
    expect(plan.nextCommands[0]).toBe("npm --workspace @peon/mcp run build");
    expect(plan.notes).toContain("This helper does not write config files, install hooks, start services, or modify the project.");
  });
});
