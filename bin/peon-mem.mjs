#!/usr/bin/env node
/**
 * peon-mem — guided installer/manager for the Peon memory brain.
 *
 *   peon-mem install [--yes] [--dry-run]   guided setup: memory home → LLM → daemon → MCP apps
 *   peon-mem uninstall                     remove service + hooks (memory data is never touched)
 *   peon-mem daemon                        run the daemon in the foreground
 *   peon-mem doctor                        health + config check
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
// PEON_FORCE_PLATFORM lets CI and maintainers exercise the other OS's install path.
const MAC = (process.env.PEON_FORCE_PLATFORM || platform()) === "darwin";
const DEFAULT_HOME = MAC ? join(HOME, "Library", "Application Support", "Peon") : join(HOME, ".local", "share", "peon");
const PLIST = join(HOME, "Library", "LaunchAgents", "com.peon.daemon.plist");
const HOOK = join(PKG, "scripts", "claude-peon-hook.mjs");
const DAEMON = join(PKG, "dist", "daemon-cli.js");
const MCP = join(PKG, "dist", "index.js");
const NODE = process.execPath;

const cmd = process.argv[2] || "help";
const DRY = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes") || !process.stdout.isTTY;
const log = (s) => console.log(s);
const act = (desc, fn) => { log((DRY ? "  [dry-run] " : "  ✔ ") + desc); if (!DRY) fn(); };
const rl = YES ? null : createInterface({ input: process.stdin, output: process.stdout });
async function ask(q, def) {
  if (!rl) return def;
  const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}

function which(bin) { return spawnSync("which", [bin], { stdio: "pipe" }).status === 0; }
function backupWrite(file, content) {
  if (existsSync(file)) copyFileSync(file, file + ".peon-backup");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---------- app detection ----------
// wire kinds: hooks+CLI (claude code) · toml (codex) · mcpServers JSON (most apps) ·
// vscode "servers" JSON · zed context_servers · manual (UI-configured apps get instructions)
const APP_SUPPORT = MAC ? join(HOME, "Library", "Application Support") : join(HOME, ".config");
function detectApps() {
  return [
    { id: "claude",   name: "Claude Code",    kind: "claude-code",
      found: which("claude") || existsSync(join(HOME, ".claude")) },
    { id: "claude-desktop", name: "Claude Desktop", kind: "json",
      file: join(APP_SUPPORT, "Claude", "claude_desktop_config.json"),
      found: existsSync(join(APP_SUPPORT, "Claude")) || existsSync("/Applications/Claude.app") },
    { id: "codex",    name: "Codex",          kind: "toml",
      found: existsSync(join(HOME, ".codex")) },
    { id: "gemini",   name: "Gemini CLI",     kind: "json",
      file: join(HOME, ".gemini", "settings.json"),
      found: which("gemini") || existsSync(join(HOME, ".gemini")) },
    { id: "cursor",   name: "Cursor",         kind: "json",
      file: join(HOME, ".cursor", "mcp.json"),
      found: existsSync(join(HOME, ".cursor")) || existsSync("/Applications/Cursor.app") },
    { id: "windsurf", name: "Windsurf",       kind: "json",
      file: join(HOME, ".codeium", "windsurf", "mcp_config.json"),
      found: existsSync(join(HOME, ".codeium", "windsurf")) || existsSync("/Applications/Windsurf.app") },
    { id: "vscode",   name: "VS Code (Copilot MCP)", kind: "vscode",
      file: MAC ? join(APP_SUPPORT, "Code", "User", "mcp.json") : join(HOME, ".config", "Code", "User", "mcp.json"),
      found: which("code") || existsSync(MAC ? join(APP_SUPPORT, "Code") : join(HOME, ".config", "Code")) },
    { id: "zed",      name: "Zed",            kind: "zed",
      file: join(HOME, ".config", "zed", "settings.json"),
      found: existsSync(join(HOME, ".config", "zed")) || existsSync("/Applications/Zed.app") },
    { id: "lmstudio", name: "LM Studio",      kind: "json",
      file: join(HOME, ".lmstudio", "mcp.json"),
      found: existsSync(join(HOME, ".lmstudio")) || existsSync("/Applications/LM Studio.app") },
    { id: "chatgpt",  name: "ChatGPT Desktop", kind: "manual",
      found: existsSync("/Applications/ChatGPT.app"),
      how: "ChatGPT → Settings → Connectors → Advanced → enable Developer Mode → add MCP server: command=" },
    { id: "perplexity", name: "Perplexity Desktop", kind: "manual",
      found: existsSync("/Applications/Perplexity.app") || existsSync("/Applications/Perplexity- Ask Anything.app"),
      how: "Perplexity → Settings → Connectors → Add Connector → Advanced: command=" }
  ];
}

// ---------- per-app wiring ----------
function wireClaude() {
  const settings = join(HOME, ".claude", "settings.json");
  let s = {}; try { s = JSON.parse(readFileSync(settings, "utf8")); } catch {}
  s.hooks = s.hooks || {};
  let changed = false;
  for (const ev of ["SessionStart", "UserPromptSubmit", "SessionEnd"]) {
    const arr = (s.hooks[ev] = s.hooks[ev] || []);
    if (!JSON.stringify(arr).includes("claude-peon-hook.mjs")) {
      arr.push({ hooks: [{ type: "command", command: `"${NODE}" "${HOOK}"` }] }); changed = true;
    }
  }
  if (changed) act("Claude Code: hooks → " + settings + " (backup kept)", () => backupWrite(settings, JSON.stringify(s, null, 2) + "\n"));
  else log("  ✔ Claude Code: hooks already present");
  if (!DRY) {
    const r = spawnSync("claude", ["mcp", "add", "peon", "--", NODE, MCP], { stdio: "ignore" });
    log(r.status === 0 ? "  ✔ Claude Code: MCP server registered" : `  → run manually: claude mcp add peon -- "${NODE}" "${MCP}"`);
  } else log("  [dry-run] Claude Code: claude mcp add peon");
}
function wireCodex() {
  const f = join(HOME, ".codex", "config.toml");
  let s = ""; try { s = readFileSync(f, "utf8"); } catch {}
  if (s.includes("[mcp_servers.peon]")) return log("  ✔ Codex: MCP already configured");
  const block = `\n[mcp_servers.peon]\ncommand = "${NODE}"\nargs = ["${MCP}"]\n\n[mcp_servers.peon.env]\nPEON_DAEMON_URL = "http://127.0.0.1:3737"\n`;
  act("Codex: [mcp_servers.peon] → " + f + " (backup kept)", () => backupWrite(f, s + block));
}
function wireJsonMcp(name, file) {
  let s = {}; try { s = JSON.parse(readFileSync(file, "utf8")); } catch {}
  s.mcpServers = s.mcpServers || {};
  if (s.mcpServers.peon) return log(`  ✔ ${name}: MCP already configured`);
  s.mcpServers.peon = { command: NODE, args: [MCP], env: { PEON_DAEMON_URL: "http://127.0.0.1:3737" } };
  act(`${name}: mcpServers.peon → ${file} (backup kept)`, () => backupWrite(file, JSON.stringify(s, null, 2) + "\n"));
}

function wireVsCode(file) {
  let s = {}; try { s = JSON.parse(readFileSync(file, "utf8")); } catch {}
  s.servers = s.servers || {};
  if (s.servers.peon) return log("  ✔ VS Code: MCP already configured");
  s.servers.peon = { type: "stdio", command: NODE, args: [MCP], env: { PEON_DAEMON_URL: "http://127.0.0.1:3737" } };
  act("VS Code: servers.peon → " + file + " (backup kept)", () => backupWrite(file, JSON.stringify(s, null, 2) + "\n"));
}
function wireZed(file) {
  let s = {}; try { s = JSON.parse(readFileSync(file, "utf8")); } catch {}
  s.context_servers = s.context_servers || {};
  if (s.context_servers.peon) return log("  ✔ Zed: MCP already configured");
  s.context_servers.peon = { command: { path: NODE, args: [MCP] }, settings: {} };
  act("Zed: context_servers.peon → " + file + " (backup kept)", () => backupWrite(file, JSON.stringify(s, null, 2) + "\n"));
}

// ---------- service ----------
function installService(memoryHome) {
  if (MAC) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.peon.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${NODE}</string>
    <string>${DAEMON}</string>
  </array>
  <key>WorkingDirectory</key><string>${memoryHome}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${memoryHome}/daemon.out.log</string>
  <key>StandardErrorPath</key><string>${memoryHome}/daemon.err.log</string>
</dict></plist>\n`;
    act("daemon service (launchd, auto-start) → " + PLIST, () => {
      mkdirSync(dirname(PLIST), { recursive: true });
      writeFileSync(PLIST, plist);
      spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" });
      execFileSync("launchctl", ["load", PLIST]);
    });
  } else {
    // Linux: write a real systemd user unit instead of printing a recipe.
    const unitDir = join(HOME, ".config", "systemd", "user");
    const unitFile = join(unitDir, "peon-mem.service");
    const unit = `[Unit]
Description=Peon memory daemon (local-first memory for AI coding agents)
After=network.target

[Service]
ExecStart=${NODE} ${DAEMON}
WorkingDirectory=${memoryHome}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
    act("daemon service (systemd user unit) → " + unitFile, () => {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unitFile, unit);
      // Enable + start when systemd is actually available; on failure fall back to instructions.
      const r = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      if (r.status === 0) {
        spawnSync("systemctl", ["--user", "enable", "--now", "peon-mem.service"], { stdio: "ignore" });
      }
    });
    log("  → if the daemon isn't running yet:");
    log("      systemctl --user daemon-reload && systemctl --user enable --now peon-mem.service");
    log("      loginctl enable-linger $USER   # keeps it running after logout");
  }
}

async function health() {
  try { const r = await fetch("http://127.0.0.1:3737/health"); return (await r.json()).ok === true; } catch { return false; }
}

// ================= commands =================
if (cmd === "install") {
  log("\n🧠 Peon setup — a memory brain for your AI agents\n");

  // Step 1 — memory home
  log("Step 1/4 · Where should Peon's GLOBAL brain live?");
  log("  (press Enter to accept the default)");
  const memoryHome = await ask("  memory home", DEFAULT_HOME);
  act("create " + memoryHome, () => mkdirSync(memoryHome, { recursive: true }));

  // Step 2 — LLM provider
  log("\nStep 2/4 · LLM for consolidation + semantic retrieval");
  log("  1) OpenRouter  — one key, any model (default: gemini-2.5-flash-lite, ~cents/day)");
  log("  2) OpenAI      — gpt-4o-mini + text-embedding-3-small");
  log("  3) Anthropic   — Claude Haiku (embeddings fall back local — pair with Ollama for semantic)");
  log("  4) Ollama      — 100% local + free (llama3.2 + nomic-embed-text on your machine)");
  log("  5) skip        — lexical-only memory, add a provider later");
  const choice = await ask("  choose 1-5", "1");
  const envFile = join(memoryHome, ".env");
  let envLines = [`# Peon config — generated by peon-mem install`];
  if (choice === "1") {
    const key = await ask("  OpenRouter API key (sk-or-…)", "");
    envLines.push("PEON_PROVIDER=openrouter", `OPENROUTER_API_KEY=${key}`,
      "PEON_PROCESSING_MODEL=google/gemini-2.5-flash-lite", "PEON_EMBEDDING_MODEL=openai/text-embedding-3-small");
  } else if (choice === "2") {
    const key = await ask("  OpenAI API key (sk-…)", "");
    envLines.push("PEON_PROVIDER=openai", `OPENAI_API_KEY=${key}`,
      "PEON_PROCESSING_MODEL=gpt-4o-mini", "PEON_EMBEDDING_MODEL=text-embedding-3-small");
  } else if (choice === "3") {
    const key = await ask("  Anthropic API key (sk-ant-…)", "");
    envLines.push("PEON_PROVIDER=anthropic", `ANTHROPIC_API_KEY=${key}`,
      "PEON_PROCESSING_MODEL=claude-haiku-4-5-20251001",
      "# Anthropic has no embeddings API — install Ollama + set PEON_EMBEDDING_MODE=ollama for semantic retrieval");
  } else if (choice === "4") {
    envLines.push("PEON_PROVIDER=ollama", "PEON_EMBEDDING_MODE=ollama",
      "PEON_PROCESSING_MODEL=llama3.2", "PEON_EMBEDDING_MODEL=nomic-embed-text");
    const up = await fetch("http://127.0.0.1:11434/api/tags").then((r) => r.ok).catch(() => false);
    if (!up) log("  → Ollama not running. Install: https://ollama.com  then: ollama pull llama3.2 && ollama pull nomic-embed-text");
    else log("  ✔ Ollama detected on :11434 — pull models if missing: ollama pull llama3.2 && ollama pull nomic-embed-text");
  } else {
    envLines.push(
      "# No-AI mode: no provider, no model calls, no embeddings. Peon runs as a",
      "# deterministic memory recorder with lexical retrieval. Re-run `peon-mem install` anytime.",
      "PEON_AI_MODE=off",
      "PEON_EMBEDDING_MODE=off"
    );
  }
  if (existsSync(envFile)) log("  ✔ keeping existing " + envFile);
  else act("write " + envFile, () => writeFileSync(envFile, envLines.join("\n") + "\n"));

  // Step 3 — daemon
  log("\nStep 3/4 · Daemon (always-on, 127.0.0.1:3737)");
  installService(memoryHome);

  // Step 4 — apps
  log("\nStep 4/4 · Wire your AI apps (detected on this machine)");
  const apps = detectApps();
  apps.forEach((a, i) => log(`  ${i + 1}) ${a.found ? "🟢" : "⚪"} ${a.name}${a.found ? "" : " (not detected)"}`));
  const detected = apps.filter((a) => a.found).map((a) => a.id);
  const pick = await ask(`  install MCP into (comma ids or 'all') — detected: ${detected.join(",") || "none"}`, detected.join(",") || "none");
  const chosen = pick === "all" ? apps.map((a) => a.id) : pick.split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of chosen) {
    const app = apps.find((a) => a.id === id);
    if (!app) { log("  ⚠ unknown app id: " + id); continue; }
    if (app.kind === "claude-code") wireClaude();
    else if (app.kind === "toml") wireCodex();
    else if (app.kind === "json") wireJsonMcp(app.name, app.file);
    else if (app.kind === "vscode") wireVsCode(app.file);
    else if (app.kind === "zed") wireZed(app.file);
    else if (app.kind === "manual") {
      log(`  → ${app.name} is configured in-app (no config file). In the app:`);
      log(`     ${app.how}"${NODE}" args=["${MCP}"]`);
    }
  }

  if (!DRY) {
    await new Promise((r) => setTimeout(r, 1500));
    log("\n" + ((await health()) ? "✔ daemon healthy — http://127.0.0.1:3737" : "⚠ daemon not answering — check " + memoryHome + "/daemon.err.log"));
  }
  log("🌌 Monitor (the Neural Universe): http://127.0.0.1:3737/monitor");
  log("Memory lives in <project>/.peon/ (child brains) + " + memoryHome + " (global brain)\n");
  rl?.close();
} else if (cmd === "uninstall") {
  if (MAC && existsSync(PLIST)) act("stop + remove daemon service", () => spawnSync("launchctl", ["unload", PLIST], { stdio: "ignore" }));
  const UNIT = join(HOME, ".config", "systemd", "user", "peon-mem.service");
  if (!MAC && existsSync(UNIT)) act("stop + remove daemon service", () => {
    spawnSync("systemctl", ["--user", "disable", "--now", "peon-mem.service"], { stdio: "ignore" });
    rmSync(UNIT, { force: true });
  });
  const settings = join(HOME, ".claude", "settings.json");
  try {
    const s = JSON.parse(readFileSync(settings, "utf8"));
    for (const ev of Object.keys(s.hooks || {}))
      s.hooks[ev] = s.hooks[ev].filter((h) => !JSON.stringify(h).includes("claude-peon-hook.mjs"));
    act("remove Peon hooks from " + settings, () => backupWrite(settings, JSON.stringify(s, null, 2) + "\n"));
  } catch {}
  log("Remove [mcp_servers.peon] / mcpServers.peon from Codex/Gemini/Cursor configs if you added them.");
  log("Memory data untouched: <project>/.peon/ and " + DEFAULT_HOME);
  rl?.close();
} else if (cmd === "daemon") {
  await import(DAEMON);
} else if (cmd === "doctor") {
  log("package : " + PKG);
  log("daemon  : " + ((await health()) ? "healthy (127.0.0.1:3737)" : "DOWN"));
  const settings = join(HOME, ".claude", "settings.json");
  log("hooks   : " + (existsSync(settings) && readFileSync(settings, "utf8").includes("claude-peon-hook.mjs") ? "installed" : "not installed"));
  log("config  : " + join(DEFAULT_HOME, ".env") + (existsSync(join(DEFAULT_HOME, ".env")) ? "" : " (missing — run peon-mem install)"));
  rl?.close();
} else {
  log("peon-mem — memory brain for AI coding agents");
  log("  peon-mem install [--yes] [--dry-run]   guided setup (memory home → LLM → daemon → apps)");
  log("  peon-mem uninstall                     remove service + hooks (data stays)");
  log("  peon-mem daemon                        run daemon in foreground");
  log("  peon-mem doctor                        health check");
  rl?.close();
}
