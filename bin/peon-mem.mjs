#!/usr/bin/env node
/**
 * peon-mem — one-command installer/manager for the Peon memory brain.
 *
 *   peon-mem install [--dry-run]   set up daemon service + Claude Code hooks + MCP
 *   peon-mem uninstall             remove service + hooks (memory data is never touched)
 *   peon-mem daemon                run the daemon in the foreground
 *   peon-mem doctor                health + config check
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(dirname(fileURLToPath(import.meta.url))); // package root
const HOME = homedir();
const MAC = platform() === "darwin";
const SUPPORT = MAC ? join(HOME, "Library", "Application Support", "Peon") : join(HOME, ".local", "share", "peon");
const PLIST = join(HOME, "Library", "LaunchAgents", "com.peon.daemon.plist");
const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
const HOOK = join(PKG, "scripts", "claude-peon-hook.mjs");
const DAEMON = join(PKG, "dist", "daemon-cli.js");
const MCP = join(PKG, "dist", "index.js");
const NODE = process.execPath;

const cmd = process.argv[2] || "help";
const DRY = process.argv.includes("--dry-run");
const log = (s) => console.log(s);
const act = (desc, fn) => { log((DRY ? "[dry-run] " : "✔ ") + desc); if (!DRY) fn(); };

function ensureBuilt() {
  if (!existsSync(DAEMON)) {
    log("dist/ missing — building…");
    spawnSync("npm", ["run", "build"], { cwd: PKG, stdio: "inherit" });
  }
  if (!existsSync(DAEMON)) { console.error("build failed — run `npm run build` in " + PKG); process.exit(1); }
}

function patchClaudeHooks() {
  let settings = {};
  try { settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")); } catch { /* fresh */ }
  settings.hooks = settings.hooks || {};
  const command = `${JSON.stringify(NODE).slice(1, -1)} ${JSON.stringify(HOOK).slice(1, -1)}`;
  let changed = false;
  for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    const arr = (settings.hooks[ev] = settings.hooks[ev] || []);
    const present = JSON.stringify(arr).includes("claude-peon-hook.mjs");
    if (!present) { arr.push({ hooks: [{ type: "command", command: `"${NODE}" "${HOOK}"` }] }); changed = true; }
  }
  if (changed) {
    if (existsSync(CLAUDE_SETTINGS)) copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".peon-backup");
    mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
    writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  }
  return changed;
}

function installService() {
  if (MAC) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.peon.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string>
    <string>${DAEMON}</string>
  </array>
  <key>WorkingDirectory</key><string>${SUPPORT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${SUPPORT}/daemon.out.log</string>
  <key>StandardErrorPath</key><string>${SUPPORT}/daemon.err.log</string>
</dict></plist>\n`;
    act("write launchd service " + PLIST, () => { mkdirSync(dirname(PLIST), { recursive: true }); writeFileSync(PLIST, plist); });
    act("start daemon (launchctl)", () => {
      spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
      execFileSync("launchctl", ["load", PLIST]);
    });
  } else {
    log("Linux: create a systemd user unit with:");
    log(`  ExecStart=${NODE} ${DAEMON}\n  WorkingDirectory=${SUPPORT}\n  Restart=always`);
  }
}

async function health() {
  try { const r = await fetch("http://127.0.0.1:3737/health"); return (await r.json()).ok === true; }
  catch { return false; }
}

if (cmd === "install") {
  ensureBuilt();
  act("create data dir " + SUPPORT, () => mkdirSync(SUPPORT, { recursive: true }));
  const env = join(SUPPORT, ".env");
  if (!existsSync(env)) act("write .env template " + env, () =>
    writeFileSync(env, "# Peon config — add your key to enable consolidation + semantic retrieval\nOPENROUTER_API_KEY=\nPEON_PROCESSING_MODEL=google/gemini-2.5-flash-lite\nPEON_EMBEDDING_MODEL=openai/text-embedding-3-small\n"));
  installService();
  const hooked = DRY ? true : patchClaudeHooks();
  log((DRY ? "[dry-run] " : "✔ ") + "Claude Code hooks " + (hooked ? "added to " + CLAUDE_SETTINGS + " (backup kept)" : "already present"));
  const mcpAdd = DRY ? { status: 1 } : spawnSync("claude", ["mcp", "add", "peon", "--", NODE, MCP], { stdio: "ignore" });
  if (mcpAdd.status === 0) log("✔ MCP server registered with Claude Code");
  else {
    log("→ register the MCP server yourself:");
    log(`   claude mcp add peon -- "${NODE}" "${MCP}"`);
    log(`   (Codex config.toml: command="${NODE}", args=["${MCP}"])`);
  }
  if (!DRY) {
    await new Promise((r) => setTimeout(r, 1500));
    log((await health()) ? "✔ daemon healthy at http://127.0.0.1:3737" : "⚠ daemon not answering yet — check " + SUPPORT + "/daemon.err.log");
  }
  log("\nDone. Add your OPENROUTER_API_KEY to " + env);
  log("Monitor: http://127.0.0.1:3737/monitor");
} else if (cmd === "uninstall") {
  if (MAC && existsSync(PLIST)) act("stop + remove launchd service", () => {
    spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
  });
  try {
    const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
    for (const ev of Object.keys(s.hooks || {}))
      s.hooks[ev] = s.hooks[ev].filter((h) => !JSON.stringify(h).includes("claude-peon-hook.mjs"));
    act("remove Peon hooks from " + CLAUDE_SETTINGS, () => writeFileSync(CLAUDE_SETTINGS, JSON.stringify(s, null, 2) + "\n"));
  } catch { /* no settings */ }
  log("Memory data untouched: <project>/.peon/ and " + SUPPORT);
} else if (cmd === "daemon") {
  ensureBuilt();
  process.argv = [NODE, DAEMON];
  await import(DAEMON);
} else if (cmd === "doctor") {
  log("package : " + PKG);
  log("daemon  : " + ((await health()) ? "healthy (127.0.0.1:3737)" : "DOWN"));
  log("hooks   : " + (existsSync(CLAUDE_SETTINGS) && readFileSync(CLAUDE_SETTINGS, "utf8").includes("claude-peon-hook.mjs") ? "installed" : "not installed"));
  log("config  : " + join(SUPPORT, ".env") + (existsSync(join(SUPPORT, ".env")) ? "" : " (missing)"));
} else {
  log("peon-mem — memory brain for AI coding agents");
  log("  peon-mem install [--dry-run]   full setup (daemon service + hooks + MCP)");
  log("  peon-mem uninstall             remove service + hooks (data stays)");
  log("  peon-mem daemon                run daemon in foreground");
  log("  peon-mem doctor                health check");
}
