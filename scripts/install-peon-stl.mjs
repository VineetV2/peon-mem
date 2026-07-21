#!/usr/bin/env node
/**
 * Install (or re-sync) the Peon STL daily cycle as a launchd job.
 *
 * It copies peon-stl.mjs into Peon's support dir (so the job is independent of any
 * git checkout / worktree), writes ~/Library/LaunchAgents/com.peon.stl.daily.plist
 * (generated from $HOME — the OpenRouter key is NEVER written into the plist), and
 * bootstraps the job into the gui/$UID domain to run daily at 09:00.
 *
 *   node scripts/install-peon-stl.mjs            # install / re-sync
 *   node scripts/install-peon-stl.mjs --run-now  # also run one cycle immediately
 *   node scripts/install-peon-stl.mjs --uninstall # remove the job
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const UID = userInfo().uid;
const LABEL = "com.peon.stl.daily";
const HERE = dirname(fileURLToPath(import.meta.url));

const SUPPORT_SCRIPTS = join(HOME, "Library", "Application Support", "Peon", "scripts");
const INSTALLED_SCRIPT = join(SUPPORT_SCRIPTS, "peon-stl.mjs");
const STL_LOG_DIR = join(HOME, "Library", "Logs", "Peon", "stl");
const PLIST_PATH = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const WORKING_DIR = join(HOME, "Documents", "Project_x 2"); // dir that holds Peon's .env

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: "pipe" }).toString(); } catch (e) { return e.stdout?.toString() || e.message; } };

function bootout() { sh("launchctl", ["bootout", `gui/${UID}/${LABEL}`]); }

if (process.argv.includes("--uninstall")) {
  bootout();
  console.log(`[install-peon-stl] booted out ${LABEL}. Plist left at ${PLIST_PATH} (delete it to fully remove).`);
  process.exit(0);
}

// 1. copy the script to the branch-independent support dir
mkdirSync(SUPPORT_SCRIPTS, { recursive: true });
mkdirSync(STL_LOG_DIR, { recursive: true });
copyFileSync(join(HERE, "peon-stl.mjs"), INSTALLED_SCRIPT);

// 2. generate the plist
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>${INSTALLED_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key><string>${WORKING_DIR}</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${join(STL_LOG_DIR, "cron.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(STL_LOG_DIR, "cron.err.log")}</string>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
</dict>
</plist>
`;
writeFileSync(PLIST_PATH, plist);

// 3. (re)bootstrap into the gui/$UID domain
bootout();
console.log(sh("launchctl", ["bootstrap", `gui/${UID}`, PLIST_PATH]).trim() || "[install-peon-stl] bootstrapped");
sh("launchctl", ["enable", `gui/${UID}/${LABEL}`]);

console.log(`[install-peon-stl] installed ${LABEL}`);
console.log(`  script : ${INSTALLED_SCRIPT}`);
console.log(`  plist  : ${PLIST_PATH}`);
console.log(`  runs   : daily 09:00 · reports → ${STL_LOG_DIR}/`);

if (process.argv.includes("--run-now")) {
  console.log("[install-peon-stl] kicking off one cycle now…");
  console.log(sh("launchctl", ["kickstart", "-k", `gui/${UID}/${LABEL}`]).trim() || "kickstarted");
}
