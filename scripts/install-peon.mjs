#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageDir = resolve(scriptDir, "..");
const defaultRepoDir = resolve(defaultPackageDir, "..");
const defaultDaemonUrl = "http://127.0.0.1:3737";
const nonDestructiveNote =
  "This helper does not write config files, install hooks, start services, or modify the project.";

if (isMain(import.meta.url, process.argv[1])) {
  await main(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    packageDir: defaultPackageDir,
    repoDir: defaultRepoDir
  });
}

export async function main(argv, options = {}) {
  let parsed;
  try {
    parsed = parseInstallArgs(argv, options.cwd || process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: node scripts/install-peon.mjs [--json] [--check|--write-plan] [project-path]");
    process.exitCode = 2;
    return;
  }

  if (parsed.help) {
    console.log(formatHelp());
    return;
  }

  const daemonUrl = normalizeUrl(options.env?.PEON_DAEMON_URL || defaultDaemonUrl);
  const packageDir = resolve(options.packageDir || defaultPackageDir);
  const repoDir = resolve(options.repoDir || defaultRepoDir);
  const checks = await collectChecks(parsed.projectPath, packageDir);
  const plan = buildInstallPlan({
    projectPath: parsed.projectPath,
    packageDir,
    repoDir,
    daemonUrl,
    checks
  });
  plan.mode = parsed.action;

  if (parsed.output === "json") {
    console.log(JSON.stringify(plan, null, 2));
  } else if (parsed.action === "write-plan") {
    console.log(formatWritePlan(plan));
  } else {
    console.log(formatTextReport(plan));
  }

  if (parsed.action === "check" && !plan.checks.ready) {
    process.exitCode = 1;
  }
}

export function parseInstallArgs(argv, cwd = process.cwd()) {
  const result = {
    action: "dry-run",
    output: "text",
    projectPath: undefined,
    help: false
  };

  for (const arg of argv) {
    if (arg === "--json") {
      result.output = "json";
    } else if (arg === "--check") {
      result.action = setAction(result.action, "check");
    } else if (arg === "--write-plan") {
      result.action = setAction(result.action, "write-plan");
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!result.projectPath) {
      result.projectPath = resolve(cwd, arg);
    } else {
      throw new Error(`Unexpected extra project path: ${arg}`);
    }
  }

  result.projectPath = resolve(result.projectPath || cwd);
  return result;
}

export function buildInstallPlan({ projectPath, packageDir, repoDir, daemonUrl, checks }) {
  const memoryDir = join(projectPath, ".peon");
  const claudeHook = join(packageDir, "scripts", "claude-peon-hook.mjs");
  const daemonBin = join(packageDir, "dist", "daemon-cli.js");
  const mcpBin = join(packageDir, "dist", "index.js");
  const launchctlLabel = "com.peon.daemon";
  const launchAgentPlist = join("~", "Library", "LaunchAgents", `${launchctlLabel}.plist`);
  const runDaemon = `PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(daemonBin)}`;
  const runMcpServer = `PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(mcpBin)}`;
  const hookCommand = `PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(claudeHook)}`;
  const ready = Boolean(checks.packageDir && checks.builtDaemon && checks.builtMcpServer && checks.claudeHook);

  return {
    mode: "dry-run",
    nonDestructive: true,
    projectPath,
    packageDir,
    repoDir,
    daemonUrl,
    paths: {
      memoryDir,
      daemonBin,
      mcpBin,
      claudeHook
    },
    checks: {
      ...checks,
      ready
    },
    launchctl: {
      label: launchctlLabel,
      plistPath: launchAgentPlist,
      recommendation:
        "Use this label for a user LaunchAgent if you choose to install the daemon with launchctl."
    },
    claude: {
      mcpConfigSnippet: {
        mcpServers: {
          peon: {
            command: "node",
            args: [mcpBin],
            env: {
              PEON_DAEMON_URL: daemonUrl
            }
          }
        }
      },
      hookCommandSnippet: hookCommand
    },
    commands: {
      build: "npm --workspace @peon/mcp run build",
      runDaemon,
      runMcpServer,
      claudeHook: hookCommand
    },
    nextCommands: buildNextCommands({ ready, daemonUrl, daemonBin, mcpBin, claudeHook }),
    notes: [
      nonDestructiveNote,
      ready ? "Build artifacts are present." : "Build artifacts are missing; run the build command first.",
      checks.projectMemoryDir
        ? "Project memory directory already exists."
        : "Project memory directory is not present yet; Peon will create it when the daemon writes memory."
    ]
  };
}

export async function collectChecks(projectPath, packageDir) {
  const daemonBin = join(packageDir, "dist", "daemon-cli.js");
  const mcpBin = join(packageDir, "dist", "index.js");
  const claudeHook = join(packageDir, "scripts", "claude-peon-hook.mjs");
  const memoryDir = join(projectPath, ".peon");

  return {
    packageDir: await exists(packageDir),
    builtDaemon: await exists(daemonBin),
    builtMcpServer: await exists(mcpBin),
    claudeHook: await exists(claudeHook),
    projectMemoryDir: await exists(memoryDir)
  };
}

export function formatTextReport(plan) {
  const status = plan.checks.ready ? "ready" : "needs build";
  return [
    `Peon installer ${plan.mode} (${status})`,
    "",
    "Paths:",
    `  Project: ${plan.projectPath}`,
    `  Daemon:  ${plan.paths.daemonBin}`,
    `  MCP:     ${plan.paths.mcpBin}`,
    `  Hook:    ${plan.paths.claudeHook}`,
    `  Memory:  ${plan.paths.memoryDir}`,
    "",
    "Checks:",
    ...formatChecks(plan.checks),
    "",
    "launchctl recommendation:",
    `  Label: ${plan.launchctl.label}`,
    `  Plist: ${plan.launchctl.plistPath}`,
    "",
    "Claude MCP config snippet:",
    indent(JSON.stringify(plan.claude.mcpConfigSnippet, null, 2), 2),
    "",
    "Claude hook command snippet:",
    `  ${plan.claude.hookCommandSnippet}`,
    "",
    "Next commands:",
    ...plan.nextCommands.map((command) => `  ${command}`),
    "",
    "Notes:",
    ...plan.notes.map((note) => `  - ${note}`)
  ].join("\n");
}

export function formatWritePlan(plan) {
  return [
    "# Peon Local Installation Plan",
    "",
    "> Planning output only. This command does not modify files, install services, or start Peon.",
    "",
    "## 1. Build Peon MCP",
    "",
    "```sh",
    plan.commands.build,
    "```",
    "",
    "## 2. Run the daemon manually",
    "",
    "```sh",
    plan.commands.runDaemon,
    "```",
    "",
    "If you later choose to use launchctl, use:",
    "",
    `- Label: \`${plan.launchctl.label}\``,
    `- Plist path: \`${plan.launchctl.plistPath}\``,
    "",
    "## 3. Add Claude MCP server config",
    "",
    "```json",
    JSON.stringify(plan.claude.mcpConfigSnippet, null, 2),
    "```",
    "",
    "## 4. Add Claude hook command",
    "",
    "```sh",
    plan.claude.hookCommandSnippet,
    "```",
    "",
    "## 5. Smoke test commands",
    "",
    "```sh",
    ...plan.nextCommands,
    "```"
  ].join("\n");
}

function formatHelp() {
  return [
    "Usage: node scripts/install-peon.mjs [--json] [--check|--write-plan] [project-path]",
    "",
    "Modes:",
    "  default       Print a non-destructive dry-run report.",
    "  --json        Print the report as JSON.",
    "  --check       Verify local build artifacts and exit 1 if required artifacts are missing.",
    "  --write-plan  Print a Markdown installation plan to stdout.",
    "",
    "This helper never writes config files, installs hooks, starts services, or calls launchctl."
  ].join("\n");
}

function formatChecks(checks) {
  return [
    ["packageDir", checks.packageDir],
    ["builtDaemon", checks.builtDaemon],
    ["builtMcpServer", checks.builtMcpServer],
    ["claudeHook", checks.claudeHook],
    ["projectMemoryDir", checks.projectMemoryDir],
    ["ready", checks.ready]
  ].map(([name, value]) => `  ${name}: ${value ? "ok" : "missing"}`);
}

function buildNextCommands({ ready, daemonUrl, daemonBin, mcpBin, claudeHook }) {
  const commands = [];
  if (!ready) commands.push("npm --workspace @peon/mcp run build");
  commands.push(`PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(daemonBin)}`);
  commands.push(`PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(mcpBin)}`);
  commands.push(`PEON_DAEMON_URL=${daemonUrl} node ${shellQuote(claudeHook)}`);
  commands.push("node peon-mcp/scripts/install-peon.mjs --check");
  return commands;
}

function setAction(current, next) {
  if (current !== "dry-run" && current !== next) {
    throw new Error("Choose only one of --check or --write-plan.");
  }
  return next;
}

function normalizeUrl(value) {
  return String(value || defaultDaemonUrl).replace(/\/$/, "");
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  );
}

function isMain(moduleUrl, argvPath) {
  return Boolean(argvPath && moduleUrl === pathToFileURL(argvPath).href);
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
