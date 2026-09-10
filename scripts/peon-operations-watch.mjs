#!/usr/bin/env node
/**
 * Is the consolidation model actually REVISING beliefs, or only appending them?
 *
 * Peon's value rests on supersede/obsolete operations — the difference between a
 * brain and a filing cabinet. A model that emits none still looks healthy: runs
 * succeed, records accumulate, nothing errors. This reads the daemon log and reports
 * per-model rates so a regression is visible instead of inferred.
 *
 * Usage: node scripts/peon-operations-watch.mjs [--since 2026-09-09] [--json]
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), "Library", "Logs", "Peon");
const args = process.argv.slice(2);
const since = (args[args.indexOf("--since") + 1] || "").match(/^\d{4}-\d{2}-\d{2}/) ? args[args.indexOf("--since") + 1] : null;
const asJson = args.includes("--json");

const files = readdirSync(LOG_DIR).filter((f) => f.startsWith("daemon.jsonl")).map((f) => join(LOG_DIR, f));
const runs = [];
for (const file of files) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.includes("process_finish")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!/^(auto_)?process_finish$/.test(entry.type ?? "")) continue;
    if (entry.status !== "processed") continue;
    if (since && (entry.createdAt ?? "") < since) continue;
    runs.push(entry);
  }
}
runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

const byModel = new Map();
for (const r of runs) {
  const key = r.model ?? "unknown";
  const a = byModel.get(key) ?? { runs: 0, operationsEmitted: 0, superseded: 0, obsoleted: 0, recordsAdded: 0, merged: 0, first: r.createdAt, last: r.createdAt };
  a.runs += 1;
  for (const k of ["operationsEmitted", "superseded", "obsoleted", "recordsAdded", "merged"]) a[k] += Number(r[k] ?? 0);
  a.last = r.createdAt;
  byModel.set(key, a);
}

const report = [...byModel.entries()].map(([model, a]) => ({
  model,
  runs: a.runs,
  opsPerRun: +(a.operationsEmitted / a.runs).toFixed(2),
  supersededPerRun: +(a.superseded / a.runs).toFixed(2),
  addedPerRun: +(a.recordsAdded / a.runs).toFixed(2),
  mergedPerRun: +(a.merged / a.runs).toFixed(2),
  totals: { ...a, first: undefined, last: undefined },
  window: `${String(a.first).slice(0, 19)} .. ${String(a.last).slice(0, 19)}`
}));

if (asJson) { console.log(JSON.stringify({ generatedAt: new Date().toISOString(), since, report }, null, 2)); process.exit(0); }

console.log(`Peon consolidation quality — ${new Date().toISOString().slice(0, 19)}Z${since ? ` (since ${since})` : ""}`);
console.log(`total consolidations: ${runs.length}\n`);
console.log("  model                             runs   ops/run  superseded/run  added/run  merged/run");
for (const r of report.sort((a, b) => b.runs - a.runs)) {
  console.log(
    `  ${r.model.padEnd(32).slice(0, 32)} ${String(r.runs).padStart(5)}  ${String(r.opsPerRun).padStart(7)}  ${String(r.supersededPerRun).padStart(14)}  ${String(r.addedPerRun).padStart(9)}  ${String(r.mergedPerRun).padStart(10)}`
  );
}
const local = report.find((r) => !r.model.includes("/") && r.model !== "manual-ai-result" && r.model !== "unknown");
if (local) {
  console.log();
  if (local.runs < 10) {
    console.log(`  NOTE: only ${local.runs} run(s) on ${local.model} — too few to judge. Keep collecting.`);
  } else if (local.opsPerRun === 0) {
    console.log(`  WARNING: ${local.model} has emitted ZERO supersede/obsolete operations across ${local.runs} runs.`);
    console.log(`  Beliefs are accumulating but never being revised — a filing cabinet, not a brain.`);
  } else {
    console.log(`  ${local.model}: ${local.opsPerRun} ops/run, ${local.supersededPerRun} superseded/run.`);
  }
}
