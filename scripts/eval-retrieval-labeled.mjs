#!/usr/bin/env node
// Labeled query-driven retrieval eval for Peon — measures the entity-graph's real lift with
// LLM-JUDGED relevance (not the shared-entity proxy). Two phases:
//
//   build:  node scripts/eval-retrieval-labeled.mjs build "<projectPath>" [N=20] [qrelsOut]
//           Samples N active beliefs, turns each into a natural question (without reusing its
//           distinctive words), pools graph-off + graph-on candidates, and has an LLM judge which
//           pool members are relevant. Writes qrels JSON.
//
//   run:    node scripts/eval-retrieval-labeled.mjs run "<projectPath>" [qrelsFile] [K=10]
//           For each labeled question, retrieves top-K with the graph OFF vs ON and reports
//           Recall@K / MRR / nDCG@K for each, plus the lift.
//
// Model: PEON_EVAL_MODEL (default = config processingModel). OpenRouter only (never Wulver).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PeonMemoryStore } from "../dist/memory-store.js";
import { loadPeonConfig } from "../dist/config.js";
import { scoreQuery, aggregate } from "../dist/eval-metrics.js";
import { gitSha, fileHash, brainFingerprint, ledgerPath, readLedger, findBaseline, appendRow } from "./lib/eval-ledger.mjs";

const [, , mode, projectPath, arg3, arg4] = process.argv;
const cfg = loadPeonConfig();
const KEY = cfg.openRouterApiKey;
const MODEL = process.env.PEON_EVAL_MODEL ?? cfg.processingModel;
if (!mode || !projectPath) { console.error("usage: build|run \"<projectPath>\" ..."); process.exit(1); }

async function chat(messages, temperature = 0) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, temperature, messages })
      });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      return (j.choices?.[0]?.message?.content ?? "").trim();
    } catch { await new Promise((res) => setTimeout(res, 800 * (attempt + 1))); }
  }
  return "";
}
const parseNums = (s) => { const m = s.match(/\[[\s\S]*?\]/); if (!m) return []; try { return JSON.parse(m[0]).map(Number).filter(Number.isInteger); } catch { return []; } };
const qrelsPath = (out) => out ?? join(projectPath, ".peon", "evaluation", "qrels.json");

async function build() {
  const N = Number.parseInt(arg3 ?? "20", 10);
  const out = qrelsPath(arg4);
  const store = await PeonMemoryStore.open({ projectPath });
  const active = (await store.listMemoryRecords()).filter((r) => r.status === "active" && r.content.trim().length > 20);
  // Deterministic spread: prefer beliefs carrying domain entities (associative recall is testable there).
  const domainish = active.filter((r) => (r.entities ?? []).some((e) => /[a-z].* .*|[a-z][A-Z]/.test(e) || (!e.includes("/") && e.length > 2)));
  const pickFrom = domainish.length >= N ? domainish : active;
  const step = Math.max(1, Math.floor(pickFrom.length / N));
  const cues = pickFrom.filter((_, i) => i % step === 0).slice(0, N);

  const qrels = [];
  let i = 0;
  for (const cue of cues) {
    const question = await chat([
      { role: "system", content: "Turn the note into ONE natural question a user might later ask that this note answers. Do NOT reuse the note's distinctive proper nouns/numbers verbatim where a natural paraphrase exists. Output only the question." },
      { role: "user", content: cue.content }
    ]);
    if (!question) continue;
    const off = await store.rankRecords(question, { limit: 15 });
    const on = await store.rankRecords(question, { limit: 15, expandGraph: true });
    const poolMap = new Map();
    for (const r of [...off, ...on, { record: cue }]) poolMap.set(r.record.id, r.record);
    const pool = [...poolMap.values()];
    const numbered = pool.map((r, n) => `${n + 1}. ${r.content.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
    const verdict = await chat([
      { role: "system", content: "Given a question and numbered notes, return ONLY a JSON array of the numbers of notes that are RELEVANT to answering it (directly or as useful related context). No prose." },
      { role: "user", content: `Question: ${question}\n\nNotes:\n${numbered}\n\nRelevant numbers:` }
    ]);
    const relevantIds = [...new Set([cue.id, ...parseNums(verdict).map((nn) => pool[nn - 1]?.id).filter(Boolean)])];
    qrels.push({ question, cueId: cue.id, relevantIds });
    process.stderr.write(`\r  labeled ${++i}/${cues.length} (${relevantIds.length} relevant)`);
  }
  mkdirSync(join(projectPath, ".peon", "evaluation"), { recursive: true });
  writeFileSync(out, JSON.stringify(qrels, null, 2));
  console.log(`\nwrote ${qrels.length} labeled queries -> ${out}`);
}

async function run() {
  const file = arg3 && existsSync(arg3) ? arg3 : qrelsPath();
  const K = Number.parseInt(arg4 ?? "10", 10);
  const qrels = JSON.parse(readFileSync(file, "utf8"));
  const store = await PeonMemoryStore.open({ projectPath });
  const off = [], on = [];
  for (const q of qrels) {
    const rel = new Set(q.relevantIds);
    const idsOff = (await store.rankRecords(q.question, { limit: K })).map((r) => r.record.id);
    const idsOn = (await store.rankRecords(q.question, { limit: K, expandGraph: true })).map((r) => r.record.id);
    off.push(scoreQuery(idsOff, rel, K));
    on.push(scoreQuery(idsOn, rel, K));
  }
  const a = aggregate(off), b = aggregate(on);
  const pct = (x) => (100 * x).toFixed(1) + "%";
  console.log(`Labeled retrieval eval — ${qrels.length} queries, K=${K}, model=${MODEL}`);
  console.log(`                Recall@${K}   MRR     nDCG@${K}`);
  console.log(`  graph OFF :   ${pct(a.recallAtK).padStart(7)}  ${a.mrr.toFixed(3)}  ${pct(a.ndcgAtK).padStart(7)}`);
  console.log(`  graph ON  :   ${pct(b.recallAtK).padStart(7)}  ${b.mrr.toFixed(3)}  ${pct(b.ndcgAtK).padStart(7)}`);
  console.log(`  lift      :   ${pct(b.recallAtK - a.recallAtK).padStart(7)}  ${(b.mrr - a.mrr >= 0 ? "+" : "") + (b.mrr - a.mrr).toFixed(3)}  ${pct(b.ndcgAtK - a.ndcgAtK).padStart(7)}`);

  // Ledger: append this run + diff against the last comparable baseline, so the graph-is-dead
  // result (and any future retrieval change) stays continuously guarded rather than a one-time memory.
  const row = {
    ts: new Date().toISOString(),
    gitSha: gitSha(),
    kind: "labeled-retrieval",
    projectPath,
    k: K,
    model: MODEL,
    queries: qrels.length,
    qrelsHash: fileHash(file),
    brain: brainFingerprint(projectPath),
    metrics: { recallOff: a.recallAtK, mrrOff: a.mrr, ndcgOff: a.ndcgAtK, recallOn: b.recallAtK, mrrOn: b.mrr, ndcgOn: b.ndcgAtK }
  };
  const lp = ledgerPath();
  const base = findBaseline(readLedger(lp), row);
  appendRow(lp, row);
  console.log(`\nledger  : +1 row → ${lp}  (git ${row.gitSha}, brain ${row.brain.records} recs/${row.brain.hash}, qrels ${row.qrelsHash})`);
  if (!base) {
    console.log("  Δ       : no comparable baseline yet — this run IS the baseline.");
  } else {
    const dp = (x) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}%`;
    const dm = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
    const m = base.row.metrics;
    const tag = base.sameBrain ? "vs last run, SAME brain (trustworthy A/B)" : "vs last run — ⚠ brain changed, informational only";
    console.log(`  Δ ${tag}:`);
    console.log(`            Recall@${K} off ${dp(a.recallAtK - m.recallOff)} / on ${dp(b.recallAtK - m.recallOn)}   MRR off ${dm(a.mrr - m.mrrOff)} / on ${dm(b.mrr - m.mrrOn)}`);
  }
}

await (mode === "build" ? build() : run());
