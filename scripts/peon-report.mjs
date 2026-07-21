#!/usr/bin/env node
/**
 * Peon analysis report.
 *
 * Reads a project's on-disk brain + the daemon log and prints what Peon did:
 * how much it captured, how often it consolidated (and what changed), how many
 * tokens that cost, and how much context it handed back. Pass two project paths
 * to compare an A/B run (e.g. Peon-off folder vs Peon-on folder).
 *
 *   node scripts/peon-report.mjs "/path/to/projectB"
 *   node scripts/peon-report.mjs "/path/to/projectA-off" "/path/to/projectB-on"
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_PATH = process.env.PEON_LOG_PATH || join(homedir(), "Library", "Logs", "Peon", "daemon.jsonl");

function readJsonl(path) {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const LOG = readJsonl(LOG_PATH);

function analyze(projectPath) {
  const peon = join(projectPath, ".peon");
  const records = readJsonl(join(peon, "brain", "memories.jsonl"));
  const messages = readJsonl(join(peon, "raw", "messages.jsonl"));
  const events = readJsonl(join(peon, "raw", "events.jsonl"));
  const state = readJson(join(peon, "brain", "processing-state.json")) || {};

  const enabled = records.length > 0 || messages.length > 0 || events.length > 0;
  const byStatus = {};
  const byType = {};
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
  }

  const logForProject = LOG.filter((e) => e.projectPath === projectPath);
  const runs = logForProject.filter((e) => e.type === "process_finish" || e.type === "auto_process_finish");
  const processed = runs.filter((e) => e.status === "processed");
  const served = logForProject.filter((e) => e.type === "context_served");

  const sum = (arr, key) => arr.reduce((a, e) => a + (Number(e[key]) || 0), 0);

  return {
    projectPath,
    enabled,
    captured: { messages: messages.length, events: events.length },
    brain: { total: records.length, byStatus, byType },
    consolidation: {
      runs: runs.length,
      processed: processed.length,
      llmTokens: sum(processed, "estimatedTokens"),
      superseded: sum(processed, "superseded"),
      obsoleted: sum(processed, "obsoleted"),
      recordsAdded: sum(processed, "recordsAdded"),
      merged: sum(processed, "merged"),
      lastModel: state.lastModel
    },
    recall: {
      contextServed: served.length,
      totalChars: sum(served, "chars"),
      avgChars: served.length ? Math.round(sum(served, "chars") / served.length) : 0
    }
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function printReport(a) {
  const name = a.projectPath.split("/").filter(Boolean).pop();
  console.log("\n" + "=".repeat(64));
  console.log(`  ${name}   ${a.enabled ? "(Peon ON)" : "(Peon OFF — no brain on disk)"}`);
  console.log("=".repeat(64));
  if (!a.enabled) {
    console.log("  No Peon data. This was a cloud-only / Peon-disabled session.");
    return;
  }
  console.log(`  Captured        ${fmt(a.captured.messages)} messages, ${fmt(a.captured.events)} events`);
  console.log(
    `  Brain           ${fmt(a.brain.total)} records  ` +
      Object.entries(a.brain.byStatus)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")
  );
  console.log(
    `  Consolidation   ${a.consolidation.processed} runs · ${fmt(a.consolidation.llmTokens)} LLM tokens (${a.consolidation.lastModel || "?"})`
  );
  console.log(
    `                  ${a.consolidation.superseded} changed-mind · ${a.consolidation.merged} merged · ${a.consolidation.recordsAdded} learned · ${a.consolidation.obsoleted} retired`
  );
  console.log(
    `  Recall          context handed back ${fmt(a.recall.contextServed)}× · ${fmt(a.recall.totalChars)} chars total · ${fmt(a.recall.avgChars)} avg/prompt`
  );
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/peon-report.mjs <projectPath> [otherProjectPath]");
  process.exit(1);
}

const reports = args.map((p) => analyze(p.replace(/\/$/, "")));
reports.forEach(printReport);

if (reports.length === 2) {
  const on = reports.find((r) => r.enabled);
  const off = reports.find((r) => !r.enabled) || reports[1];
  console.log("\n" + "=".repeat(64));
  console.log("  A/B SUMMARY");
  console.log("=".repeat(64));
  if (on) {
    console.log(
      `  Peon overhead this run: ${fmt(on.consolidation.llmTokens)} tokens on ${on.consolidation.lastModel || "the consolidation model"} (cheap),`
    );
    console.log(
      `  in exchange for auto-injecting context ${fmt(on.recall.contextServed)} times (${fmt(on.recall.totalChars)} chars) so you did not have to re-explain.`
    );
  }
  console.log(
    "\n  NOTE: Peon cannot see your main model's token usage (that is on the AI\n" +
      "  provider's side). Compare the MAIN model's tokens between the two folders\n" +
      "  from your AI tool's own usage view; this report quantifies Peon's overhead\n" +
      "  and the context it added, which is the other half of that trade-off."
  );
}
console.log("");
