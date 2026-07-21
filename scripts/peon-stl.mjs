#!/usr/bin/env node
/**
 * Peon STL cycle — Self-Tracking Loop.
 *
 * Runs once every 24h and keeps an eye on what Peon has been doing. It answers the
 * four questions, for the trailing 24h window:
 *
 *   CHECK 1  RECORDED   — what Peon captured (raw messages/events/tool-calls) and
 *                         what new beliefs it wrote, per project.
 *   CHECK 2  INJECTED   — what context Peon handed back to Claude ("in the cloud"):
 *                         how often, how big, for which queries, per project.
 *   CHECK 3  WENT WRONG — failures split into the INJECTION path (context/overview)
 *                         and the RECORDING path (record/session-end/consolidation),
 *                         de-duplicating the client-side hook mirror of a server 5xx.
 *   CHECK 4  PROCESSING — "process_last_24_hours": the consolidation runs in the
 *                         window — processed / skipped / failed — with a recovery-aware
 *                         correctness verdict (healthy / healthy-with-failures /
 *                         FAILING / churning / gated-ok / idle) per project.
 *
 * It writes a dated report + latest.{md,json} + appends history.jsonl, and — if an
 * OpenRouter key is present — adds a short LLM diagnosis. It is READ-ONLY on memory
 * by default; pass --fix (or PEON_STL_FIX=1) to also run the safe, reversible
 * recuration pass on projects with a conflict backlog (with an up-front daemon
 * health check). It NEVER edits Peon's code or config, and it ALWAYS writes a report
 * — even a degraded one if analysis throws.
 *
 *   node scripts/peon-stl.mjs            # diagnose + report (default, safe)
 *   node scripts/peon-stl.mjs --fix      # also recurate high-conflict projects
 *   PEON_STL_WINDOW_HOURS=48 node scripts/peon-stl.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname, parse as parsePath } from "node:path";
import { isServerFault } from "./lib/stl-classify.mjs";

// ---------- config ----------
const HOME = homedir();
const SUPPORT = join(HOME, "Library", "Application Support", "Peon");
const LOGS = join(HOME, "Library", "Logs", "Peon");
const DAEMON_LOG = process.env.PEON_LOG_PATH || join(LOGS, "daemon.jsonl");
const HOOK_ERRORS = join(SUPPORT, "claude-hooks", "errors.jsonl");
const ERR_LOG = join(SUPPORT, "daemon.err.log");
const PROJECTS_JSON = join(SUPPORT, "projects.json");
const REPORT_DIR = join(LOGS, "stl");
const DAEMON = process.env.PEON_DAEMON_URL || "http://127.0.0.1:3737";

const WINDOW_HOURS = Number(process.env.PEON_STL_WINDOW_HOURS) || 24;
const WINDOW_MS = WINDOW_HOURS * 3600 * 1000;
const NOW = Date.now();
const CUTOFF = NOW - WINDOW_MS;
const DO_FIX = process.argv.includes("--fix") || process.env.PEON_STL_FIX === "1";

const CONFLICT_THRESHOLD = 10;          // recurate / flag once unresolved-conflict backlog crosses this
const HIGH_FAILURE_RATE = 0.34;         // >1/3 of consolidation runs failing == genuinely FAILING
const LOG_TAIL_CAP_BYTES = 80 * 1024 * 1024; // bound memory on append-only logs as they grow
const RECURATE_TIMEOUT_MS = Number(process.env.PEON_STL_RECURATE_TIMEOUT_MS) || 600000; // LLM recuration is slow

// ---------- io helpers ----------
function parseLines(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip bad line */ }
  }
  return out;
}
/** Read only the tail of a (possibly huge) append-only log, then drop the first partial line. */
function readJsonlTail(path, capBytes = LOG_TAIL_CAP_BYTES) {
  let size = 0;
  try { size = statSync(path).size; } catch { return []; }
  if (size <= capBytes) {
    try { return parseLines(readFileSync(path, "utf8")); } catch { return []; }
  }
  const start = size - capBytes;
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(capBytes);
    readSync(fd, buf, 0, capBytes, start);
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    return parseLines(nl >= 0 ? text.slice(nl + 1) : text);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}
const readJsonl = (p) => readJsonlTail(p); // all our jsonl reads are append-only → tail-capped
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
const ts = (e) => new Date(e?.createdAt || e?.at || e?.ts || e?.timestamp || 0).getTime();
const within = (e) => { const t = ts(e); return t >= CUTOFF && t <= NOW + 60000; };
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

/** Count append-only jsonl lines whose timestamp falls in the window (tail-capped). */
function countWithin(path) {
  let n = 0, total = 0;
  for (const e of readJsonlTail(path)) { total++; if (within(e)) n++; }
  return { window: n, total };
}

// ---------- classification ----------
/** A git worktree under .claude/worktrees/<x> is the same project as its parent checkout. */
function canonicalProject(p) {
  if (typeof p !== "string") return "";
  const marker = "/.claude/worktrees/";
  const idx = p.indexOf(marker);
  return idx !== -1 ? p.slice(0, idx) : p;
}
/** Which Peon path a request belongs to: injection (serving memory) vs recording (capturing it). */
function classifyPath(path) {
  const p = String(path || "");
  if (/^\/(context|overview|build_injection|network|cross)/.test(p)) return "injection";
  if (/^\/(sessions|messages|events|process|record|recurate)/.test(p)) return "recording";
  return "other";
}

function isRealProject(p) {
  if (!p || typeof p !== "string") return false;
  if (/\/peon-test-project|\/private\/var\/folders|\/tmp\/|node_modules/.test(p)) return false;
  try { statSync(join(p, ".peon", "brain", "memories.jsonl")); return true; } catch { return false; }
}
function discoverProjects(logEntries) {
  const set = new Set();
  const list = readJson(PROJECTS_JSON);
  for (const p of Array.isArray(list) ? list : []) { const c = canonicalProject(p); if (c) set.add(c); }
  for (const e of logEntries) if (e.projectPath) { const c = canonicalProject(e.projectPath); if (c) set.add(c); }
  return [...set].filter(isRealProject).sort();
}

/** Resolve the OpenRouter key the same way the daemon does: env first, then a climbed .env. */
function resolveOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  let cur = process.cwd();
  const root = parsePath(cur).root;
  while (true) {
    const f = join(cur, ".env");
    try {
      if (existsSync(f)) {
        for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
          const m = line.match(/^\s*OPENROUTER_API_KEY\s*=\s*(.+)\s*$/);
          if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
        }
      }
    } catch { /* unreadable .env → keep climbing */ }
    if (cur === root) return undefined;
    cur = dirname(cur);
  }
}

// ---------- daemon log ----------
const LOG = readJsonlTail(DAEMON_LOG).filter(within);
for (const e of LOG) if (e.projectPath) e.projectPath = canonicalProject(e.projectPath); // fold worktrees into parent

function analyzeDaemonLog() {
  const types = {};
  const served = [], crossServed = [], procFinish = [], procFail = [], recurates = [];
  const http5xx = [];
  const injByProject = {};
  for (const e of LOG) {
    types[e.type] = (types[e.type] || 0) + 1;
    switch (e.type) {
      case "context_served": served.push(e); injByProject[e.projectPath || "?"] = (injByProject[e.projectPath || "?"] || 0) + 1; break;
      case "cross_context_served": crossServed.push(e); break;
      case "process_finish": case "auto_process_finish": procFinish.push(e); break;
      case "auto_process_fail": case "process_fail": procFail.push(e); break;
      case "recurate": recurates.push(e); break;
      case "response_out": if (isServerFault(e)) http5xx.push(e); break; // client aborts (error:"aborted") are not server faults
    }
  }
  const sum = (arr, k) => arr.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const inj = http5xx.filter((e) => classifyPath(e.path) === "injection");
  const rec = http5xx.filter((e) => classifyPath(e.path) === "recording");
  const other = http5xx.filter((e) => classifyPath(e.path) === "other");
  return { types, served, crossServed, procFinish, procFail, recurates, http5xx, http5xxByPath: { inj, rec, other }, injByProject, sum };
}

function analyzeHookErrors() {
  const all = readJsonlTail(HOOK_ERRORS).filter(within);
  const classify = (m) => {
    if (/Unknown Peon session/.test(m)) return { sig: "stale session-end (benign — now auto-degraded)", benign: true, mirror5xx: true };
    if (/Unexpected token|Unexpected (number|string|end)|in JSON|not valid JSON/.test(m)) return { sig: "consolidation JSON parse (malformed model output)", benign: false, mirror5xx: true };
    if (/ECONNREFUSED|fetch failed|ENOTFOUND/.test(m)) return { sig: "daemon unreachable", benign: false, mirror5xx: false };
    if (/timed out|timeout/i.test(m)) return { sig: "timeout", benign: false, mirror5xx: false };
    if (/failed with 5\d\d|\b5\d\d\b/.test(m)) return { sig: "daemon 5xx (other)", benign: false, mirror5xx: true };
    if (/failed with 4\d\d|\b4\d\d\b/.test(m)) return { sig: "daemon 4xx", benign: false, mirror5xx: false };
    return { sig: m.slice(0, 60) || "unknown", benign: false, mirror5xx: false };
  };
  const by = {}, samples = {};
  let benign = 0, mirror5xx = 0, standalone = 0; // standalone = a failure with no server 5xx behind it
  for (const e of all) {
    const c = classify(String(e.error || ""));
    const k = `${e.eventName || "?"} :: ${c.sig}`;
    by[k] = (by[k] || 0) + 1;
    if (!samples[k]) samples[k] = String(e.error || "").slice(0, 200);
    if (c.benign) benign++;
    if (c.mirror5xx) mirror5xx++; else standalone++;
  }
  return { count: all.length, by, samples, benign, mirror5xx, standalone };
}

function analyzeRestarts() {
  let raw = "";
  try { raw = readFileSync(ERR_LOG, "utf8"); } catch { return { boots: 0, stderr: [] }; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return { boots: lines.filter((l) => /listening on/.test(l)).length, stderr: lines.filter((l) => !/listening on/.test(l)).slice(-8) };
}

function analyzeProject(p) {
  const brainDir = join(p, ".peon", "brain");
  const rawDir = join(p, ".peon", "raw");
  const records = readJsonl(join(brainDir, "memories.jsonl"));
  const state = readJson(join(brainDir, "processing-state.json")) || {};
  const quality = readJson(join(brainDir, "quality-report.json")) || {};

  const byStatus = {}; let activeTotal = 0, newBeliefs = 0; const newByType = {};
  for (const r of records) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === "active") activeTotal++;
    if (within(r)) { newBeliefs++; newByType[r.type] = (newByType[r.type] || 0) + 1; }
  }

  const msgs = countWithin(join(rawDir, "messages.jsonl"));
  const evs = countWithin(join(rawDir, "events.jsonl"));
  const tools = countWithin(join(rawDir, "tool-calls.jsonl"));

  // CHECK 4 — consolidation runs for THIS project in the window
  const runs = LOG.filter((e) => e.projectPath === p && /process_(finish|fail)$/.test(e.type));
  const processed = runs.filter((e) => e.status === "processed");
  const skipped = runs.filter((e) => e.status === "skipped");
  const failed = runs.filter((e) => /process_fail$/.test(e.type));
  const sum = (arr, k) => arr.reduce((a, e) => a + (Number(e[k]) || 0), 0);
  const recordsAdded = sum(processed, "recordsAdded");
  const reconciled = sum(processed, "superseded") + sum(processed, "merged") + sum(processed, "obsoleted");
  const llmTokens = sum(processed, "estimatedTokens") + sum(failed, "estimatedTokens");

  const conflicts = Array.isArray(quality.conflicts) ? quality.conflicts.length : 0;
  const duplicates = Array.isArray(quality.duplicates) ? quality.duplicates.length : 0;
  const stale = Array.isArray(quality.staleIds) ? quality.staleIds.length : 0;

  // recovery-aware verdict — a single transient fail among many good runs is NOT "FAILING"
  const attempts = processed.length + failed.length;
  const failureRate = attempts ? failed.length / attempts : 0;
  const lastFailTs = failed.length ? Math.max(...failed.map(ts)) : 0;
  const recoveredAfterFail = failed.length > 0 && processed.some((e) => ts(e) > lastFailTs);
  const lastRunFailed = runs.length > 0 && /process_fail$/.test(runs.slice().sort((a, b) => ts(a) - ts(b)).at(-1).type);

  let verdict, reason;
  if (runs.length === 0) { verdict = "idle"; reason = "no consolidation ran in window"; }
  else if (failed.length === 0 && processed.length > 0) { verdict = "healthy"; reason = `${processed.length} run(s), +${recordsAdded} beliefs, ${reconciled} reconciled`; }
  else if (failed.length === 0) { verdict = "gated-ok"; reason = `${skipped.length} run(s) correctly skipped below cost gate`; }
  else if (failureRate >= HIGH_FAILURE_RATE || (lastRunFailed && !recoveredAfterFail)) {
    verdict = "FAILING"; reason = `${failed.length}/${attempts} runs failed (${Math.round(failureRate * 100)}%)${lastRunFailed ? ", last run failed, no recovery" : ""}`;
  } else if (processed.length > 0 && recordsAdded === 0 && reconciled === 0) {
    verdict = "churning"; reason = `${processed.length} run(s) cost ${fmt(llmTokens)} tokens but learned/changed nothing`;
  } else {
    verdict = "healthy-with-failures"; reason = `${processed.length} ok + ${failed.length} transient fail(s) (${Math.round(failureRate * 100)}%), recovered (last run succeeded)`;
  }

  // conflict backlog is a SEPARATE, pre-existing signal — do not frame it as decay caused by idleness
  const conflictBacklog = conflicts >= CONFLICT_THRESHOLD;

  return {
    name: basename(p), path: p,
    recorded: { messages: msgs.window, events: evs.window, toolCalls: tools.window, newBeliefs, newByType },
    brain: { total: records.length, active: activeTotal, byStatus, conflicts, duplicates, stale, conflictBacklog },
    processing: {
      runs: runs.length, processed: processed.length, skipped: skipped.length, failed: failed.length,
      recordsAdded, reconciled, llmTokens, failureRate: Math.round(failureRate * 100),
      lastStatus: state.lastStatus, lastProcessedAt: state.lastProcessedAt, lastModel: state.lastModel, verdict, reason
    }
  };
}

// ---------- remediation (only with --fix) ----------
async function daemonHealthy() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try { return (await fetch(`${DAEMON}/health`, { signal: ctrl.signal, headers: { host: "127.0.0.1" } })).ok; }
  catch { return false; } finally { clearTimeout(t); }
}
async function recurate(projectPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RECURATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${DAEMON}/recurate`, {
      method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1" },
      body: JSON.stringify({ projectPath }), signal: ctrl.signal
    });
    if (!res.ok) return { projectPath, ok: false, error: `HTTP ${res.status}` };
    return { projectPath, ok: true, ...(await res.json()) };
  } catch (e) { return { projectPath, ok: false, error: ctrl.signal.aborted ? `timed out after ${RECURATE_TIMEOUT_MS}ms` : (e?.message || "failed") }; }
  finally { clearTimeout(t); }
}

// ---------- LLM diagnosis (optional, graceful, one retry) ----------
async function diagnose(findings) {
  const key = resolveOpenRouterKey();
  if (!key) return null;
  const model = process.env.PEON_PROCESSING_MODEL || process.env.PEON_SUMMARY_MODEL || "google/gemini-2.5-flash-lite";
  const prompt = [
    "You are Peon's ops doctor. Peon is a local memory-brain for Claude Code: it RECORDS sessions,",
    "CONSOLIDATES them into beliefs, and INJECTS relevant memory back into Claude.",
    "Below are the last-24h metrics from its self-tracking loop. Diagnose tersely:",
    "1) The top 1-3 real problems (ignore healthy signals; transient-but-recovered fails are minor).",
    "2) The most likely root cause of each.",
    "3) One concrete fix or action per problem.",
    "End with a one-line overall verdict. Plain markdown, no preamble.",
    "", "```json", JSON.stringify(findings, null, 1), "```"
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: "user", content: prompt }] }), signal: ctrl.signal
      });
      if (res.ok) { const data = await res.json(); return data?.choices?.[0]?.message?.content?.trim() || null; }
      if (res.status < 500 || attempt === 1) return `_(diagnosis unavailable: HTTP ${res.status})_`;
    } catch (e) { if (attempt === 1) return `_(diagnosis unavailable: ${e?.message || "error"})_`; }
    finally { clearTimeout(t); }
  }
  return null;
}

// ---------- report ----------
function buildReport(d) {
  const L = [];
  const stamp = new Date(NOW).toISOString().replace("T", " ").slice(0, 16);
  L.push(`# 🧠 Peon STL Cycle — ${stamp} (trailing ${WINDOW_HOURS}h)`, "");
  L.push(`**Verdict:** ${d.headline}`, "");
  L.push(`Projects: ${d.projects.length} · daemon requests: ${fmt(d.daemon.types.request_in || 0)} · injections: ${fmt(d.daemon.served.length)} · consolidations: ${fmt(d.daemon.procFinish.length)} (${d.daemon.procFail.length} failed) · distinct failures: ${d.errors.distinct} (${d.errors.serious} serious)`, "");

  // CHECK 1
  L.push(`## 1 · Recorded (last ${WINDOW_HOURS}h)`);
  const rec = d.projects.reduce((a, p) => ({ m: a.m + p.recorded.messages, e: a.e + p.recorded.events, t: a.t + p.recorded.toolCalls, b: a.b + p.recorded.newBeliefs }), { m: 0, e: 0, t: 0, b: 0 });
  L.push(`Captured **${fmt(rec.m)} messages**, ${fmt(rec.e)} events, ${fmt(rec.t)} tool-calls → wrote **${fmt(rec.b)} new beliefs**.`, "");
  L.push("| Project | msgs | events | tools | new beliefs |", "|---|--:|--:|--:|--:|");
  for (const p of d.projects.filter((p) => p.recorded.messages || p.recorded.events || p.recorded.newBeliefs))
    L.push(`| ${p.name} | ${fmt(p.recorded.messages)} | ${fmt(p.recorded.events)} | ${fmt(p.recorded.toolCalls)} | ${fmt(p.recorded.newBeliefs)} |`);
  L.push("", `_Counts read at report time; append-only raw logs may have grown since the window closed._`, "");

  // CHECK 2
  L.push(`## 2 · Injected into Claude (last ${WINDOW_HOURS}h)`);
  const totalChars = d.daemon.sum(d.daemon.served, "chars");
  const avg = d.daemon.served.length ? Math.round(totalChars / d.daemon.served.length) : 0;
  const compacted = d.daemon.served.filter((e) => e.compacted).length;
  L.push(`Injected context **${fmt(d.daemon.served.length)}×** (+${fmt(d.daemon.crossServed.length)} cross-project), ${fmt(totalChars)} chars total, ${fmt(avg)} avg/prompt. ${compacted} were budget-compacted.`, "");
  // Serve-time telemetry (present on events emitted after the telemetry build) — averaged over the
  // events that carry it, so the production cost/latency is OBSERVED, not assumed.
  const withTel = d.daemon.served.filter((e) => typeof e.latencyMs === "number");
  if (withTel.length) {
    const avgMs = Math.round(d.daemon.sum(withTel, "latencyMs") / withTel.length);
    const p95 = withTel.map((e) => e.latencyMs).sort((a, b) => a - b)[Math.min(withTel.length - 1, Math.floor(withTel.length * 0.95))];
    const avgTok = Math.round(d.daemon.sum(withTel, "estTokens") / withTel.length);
    L.push(`Serve cost (${withTel.length} instrumented): **~${fmt(avgTok)} tokens/injection**, latency avg ${fmt(avgMs)}ms / p95 ${fmt(p95)}ms.`, "");
  }
  const recent = d.daemon.served.slice(-6).map((e) => `\`${(e.query || "").replace(/\s+/g, " ").slice(0, 70)}\` → ${fmt(e.chars)}ch`).reverse();
  if (recent.length) { L.push("Recent injection queries:"); for (const r of recent) L.push(`- ${r}`); }
  L.push("", `_Peon logs each injection's query + size, not the served text — this is the envelope, not the substance. (Use the live monitor /overview to replay the last full injection.)_`, "");

  // CHECK 3
  L.push(`## 3 · What went wrong`);
  const inj = d.daemon.http5xxByPath.inj, recd = d.daemon.http5xxByPath.rec, oth = d.daemon.http5xxByPath.other;
  L.push(`**Injection path:** ${inj.length ? `${inj.length} server 5xx ⚠️` : "0 errors ✅"}  ·  **Recording path:** ${recd.length ? `${recd.length} server 5xx` : "0 errors ✅"}${oth.length ? `  ·  other: ${oth.length}` : ""}`);
  const grp = (arr) => { const m = {}; for (const e of arr) m[e.path || "?"] = (m[e.path || "?"] || 0) + 1; return Object.entries(m).map(([k, v]) => `${v}× \`${k}\``).join(", "); };
  if (recd.length) L.push(`- recording 5xx: ${grp(recd)}`);
  if (inj.length) L.push(`- injection 5xx: ${grp(inj)}`);
  if (d.hooks.count) {
    L.push(`\n**Hook errors (${d.hooks.count})** — what Claude's hooks saw (the ${d.hooks.mirror5xx} marked benign/mirror are the client-side echo of the server 5xx above, not separate failures):`);
    for (const [k, v] of Object.entries(d.hooks.by).sort((a, b) => b[1] - a[1]))
      L.push(`  - ${v}× ${k}${d.hooks.samples[k] ? `  \n    \`${d.hooks.samples[k].replace(/`/g, "'")}\`` : ""}`);
  }
  if (!inj.length && !recd.length && !oth.length && !d.hooks.count) L.push("No injection- or recording-path errors in the window. ✅");
  L.push(`\n_Distinct failures: **${d.errors.distinct}** (server 5xx + connection failures with no server response), of which **${d.errors.serious}** serious (excludes ${d.hooks.benign} benign stale session-ends). Daemon boot banners in err.log: ${d.restarts.boots}._`, "");

  // CHECK 4
  L.push(`## 4 · process_last_24_hours — consolidation correctness`);
  const proc = d.daemon;
  L.push(`Consolidation ran **${proc.procFinish.length + proc.procFail.length}×**: ${proc.procFinish.filter((e) => e.status === "processed").length} processed, ${proc.procFinish.filter((e) => e.status === "skipped").length} skipped (cost-gated), **${proc.procFail.length} failed**.`, "");
  L.push("| Project | runs | proc | skip | fail | learned | tokens | verdict |", "|---|--:|--:|--:|--:|--:|--:|---|");
  for (const p of d.projects.filter((p) => p.processing.runs))
    L.push(`| ${p.name} | ${p.processing.runs} | ${p.processing.processed} | ${p.processing.skipped} | ${p.processing.failed} | ${p.processing.recordsAdded}+${p.processing.reconciled} | ${fmt(p.processing.llmTokens)} | ${p.processing.verdict} |`);
  const flagged = d.projects.filter((p) => ["FAILING", "churning"].includes(p.processing.verdict));
  if (flagged.length) { L.push("", "**Flagged (needs attention):**"); for (const p of flagged) L.push(`- **${p.name}** — ${p.processing.reason}.`); }
  const transient = d.projects.filter((p) => p.processing.verdict === "healthy-with-failures");
  if (transient.length) { L.push("", "**Transient (self-recovered, informational):**"); for (const p of transient) L.push(`- ${p.name} — ${p.processing.reason}.`); }
  L.push("");

  // brain health + conflict backlog (pre-existing, not framed as decay)
  L.push(`## Brain health (current state)`);
  L.push("| Project | active | conflicted | conflicts | dupes | stale |", "|---|--:|--:|--:|--:|--:|");
  for (const p of d.projects)
    L.push(`| ${p.name} | ${fmt(p.brain.active)} | ${fmt(p.brain.byStatus.conflicted || 0)} | ${fmt(p.brain.conflicts)} | ${fmt(p.brain.duplicates)} | ${fmt(p.brain.stale)} |`);
  const backlog = d.projects.filter((p) => p.brain.conflictBacklog);
  if (backlog.length) {
    L.push("", `**Conflict backlog** (pre-existing unresolved conflicts — reconcile via \`--fix\` or a consolidation pass; not caused by the window):`);
    for (const p of backlog) L.push(`- ${p.name}: ${p.brain.conflicts} conflicts${p.processing.lastProcessedAt ? ` (last consolidation ${String(p.processing.lastProcessedAt).slice(0, 10)})` : ""}`);
  }
  L.push("");

  // remediation
  L.push(`## Remediation`);
  if (!DO_FIX) {
    L.push(backlog.length
      ? `Report-only run. Re-run with \`--fix\` to recurate the conflict backlog: ${backlog.map((p) => p.name).join(", ")}.`
      : "Report-only run. No project crossed the remediation threshold.");
  } else if (d.remediation?.skipped) {
    L.push(`⚠️ \`--fix\` requested but ${d.remediation.skipped} — remediation skipped.`);
  } else if (d.remediation?.results?.length) {
    for (const r of d.remediation.results) L.push(`- ${r.ok ? `✅ ${basename(r.projectPath)} — archived ${r.archived}/${r.considered}` : `⚠️ ${basename(r.projectPath)} — ${r.error}`}`);
  } else {
    L.push("`--fix` enabled but no project crossed the remediation threshold.");
  }
  L.push("");

  if (d.diagnosis) { L.push(`## 🩺 Diagnosis & recommended fixes`, "", d.diagnosis, ""); }
  L.push(`---\n_STL cycle generated ${new Date(NOW).toISOString()} · window ${new Date(CUTOFF).toISOString()} → now · source: daemon.jsonl + per-project .peon brains._`);
  return L.join("\n");
}

function writeReport(md, jsonPayload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const day = new Date(NOW).toISOString().slice(0, 10);
  writeFileSync(join(REPORT_DIR, `${day}.md`), md);
  writeFileSync(join(REPORT_DIR, "latest.md"), md);
  writeFileSync(join(REPORT_DIR, "latest.json"), JSON.stringify(jsonPayload, null, 2));
  return join(REPORT_DIR, `${day}.md`);
}

// ---------- main ----------
async function main() {
  const daemon = analyzeDaemonLog();
  const hooks = analyzeHookErrors();
  const restarts = analyzeRestarts();
  const projects = [];
  for (const p of discoverProjects(LOG)) {
    try { projects.push(analyzeProject(p)); }
    catch (e) { console.error(`[peon-stl] skipped project ${p}: ${e?.message || e}`); }
  }

  // de-duplicated failure counts (a hook 5xx is the client echo of a server 5xx — count once)
  const distinct = daemon.http5xx.length + hooks.standalone;       // server 5xx + connection-only failures
  const serious = Math.max(0, distinct - hooks.benign);            // exclude benign stale session-ends
  const errors = { distinct, serious, injection: daemon.http5xxByPath.inj.length, recording: daemon.http5xxByPath.rec.length };

  // headline — 🔴 only for genuinely broken; 🟡 for transient/backlog
  const failing = projects.filter((p) => ["FAILING", "churning"].includes(p.processing.verdict));
  const transient = projects.filter((p) => p.processing.verdict === "healthy-with-failures");
  const backlog = projects.filter((p) => p.brain.conflictBacklog);
  let headline = "🟢 Healthy — recording, injecting, and consolidating normally.";
  if (errors.injection > 0) headline = `🔴 Attention — ${errors.injection} injection-path failure(s): Claude may be getting no/broken memory.`;
  else if (failing.length) headline = `🔴 Attention — consolidation ${failing.map((p) => `${p.name} (${p.processing.verdict})`).join(", ")}.`;
  else if (serious > 10) headline = `🟡 Degraded — ${serious} serious recording-path errors.`;
  else if (transient.length || serious > 0 || backlog.length) {
    const bits = [];
    if (transient.length || daemon.procFail.length) bits.push(`${daemon.procFail.length} transient consolidation fail(s) (self-recovered)`);
    if (backlog.length) bits.push(`conflict backlog in ${backlog.map((p) => p.name).join(", ")}`);
    headline = `🟡 Watch — ${bits.join("; ") || `${serious} minor error(s)`}.`;
  }

  // remediation (only with --fix, only when daemon is up)
  let remediation = null;
  if (DO_FIX) {
    const targets = backlog.map((p) => p.path);
    if (!targets.length) remediation = { results: [] };
    else if (!(await daemonHealthy())) { remediation = { skipped: "daemon unreachable" }; headline += " (remediation skipped: daemon down)"; }
    else { remediation = { results: [] }; for (const t of targets) remediation.results.push(await recurate(t)); }
  }

  const findings = {
    window: { hours: WINDOW_HOURS, from: new Date(CUTOFF).toISOString(), to: new Date(NOW).toISOString() },
    headline, errors,
    recorded: projects.map((p) => ({ project: p.name, ...p.recorded })),
    injected: { count: daemon.served.length, cross: daemon.crossServed.length, totalChars: daemon.sum(daemon.served, "chars"), byProject: daemon.injByProject },
    wentWrong: { injectionPath5xx: errors.injection, recordingPath5xx: errors.recording, distinctFailures: distinct, seriousFailures: serious, benignStale: hooks.benign, hookErrors: hooks.by, daemonBoots: restarts.boots, consolidationFails: daemon.procFail.length },
    processing: projects.map((p) => ({ project: p.name, ...p.processing })),
    brain: projects.map((p) => ({ project: p.name, ...p.brain }))
  };
  const diagnosis = await diagnose(findings);

  const md = buildReport({ daemon, hooks, restarts, projects, headline, errors, remediation, diagnosis });
  const reportPath = writeReport(md, { ...findings, diagnosis, generatedAt: new Date(NOW).toISOString() });
  appendFileSync(join(REPORT_DIR, "history.jsonl"), JSON.stringify({
    at: new Date(NOW).toISOString(), headline, projects: projects.length,
    recordedMsgs: findings.recorded.reduce((a, r) => a + r.messages, 0),
    injections: daemon.served.length, consolidations: daemon.procFinish.length,
    consolidationFails: daemon.procFail.length, distinctFailures: distinct, seriousFailures: serious,
    injectionPath5xx: errors.injection, fixed: remediation?.results?.filter((r) => r.ok).length || 0
  }) + "\n");

  console.log(`[peon-stl] ${headline}`);
  console.log(`[peon-stl] report → ${reportPath}`);
}

// ALWAYS leave a report behind — for an unattended monitor, a silent total failure is the worst outcome.
main().catch((e) => {
  console.error("[peon-stl] analysis failed:", e?.stack || e);
  try {
    const md = `# 🧠 Peon STL Cycle — ${new Date(NOW).toISOString().slice(0, 16)}\n\n**Verdict:** 🔴 STL run errored before completing.\n\n\`\`\`\n${String(e?.stack || e).slice(0, 2000)}\n\`\`\`\n\n_The daily self-tracking loop hit an error; this stub is written so the failure is visible. Check daemon.jsonl + this script._\n`;
    writeReport(md, { error: String(e?.message || e), generatedAt: new Date(NOW).toISOString() });
    appendFileSync(join(REPORT_DIR, "history.jsonl"), JSON.stringify({ at: new Date(NOW).toISOString(), headline: "🔴 STL run errored", error: String(e?.message || e) }) + "\n");
  } catch { /* last-resort: nothing else we can do */ }
  process.exit(1);
});
