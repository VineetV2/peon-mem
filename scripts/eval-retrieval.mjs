#!/usr/bin/env node
// Retrieval evaluation harness for Peon.
//
// Builds a labeled query→gold-belief set (LLM-generated, realistic), then scores
// the LIVE retrieval ranker with standard IR metrics (Recall@K, MRR, nDCG@10).
// The eval set is SAVED so the identical queries re-score before/after a ranker
// change — a fair A/B.
//
//   node scripts/eval-retrieval.mjs build "<projectPath>" [N]   # generate + save the set
//   node scripts/eval-retrieval.mjs run   "<projectPath>"       # score current ranker on saved set
//   node scripts/eval-retrieval.mjs       "<projectPath>" [N]   # build-if-missing then run
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PeonMemoryStore } from "../dist/memory-store.js";
import { loadPeonConfig } from "../dist/config.js";

const [, , maybeMode, ...rest] = process.argv;
const MODES = new Set(["build", "run"]);
const mode = MODES.has(maybeMode) ? maybeMode : "auto";
const projectPath = (MODES.has(maybeMode) ? rest[0] : maybeMode) ?? process.cwd();
const N = Number.parseInt((MODES.has(maybeMode) ? rest[1] : rest[0]) ?? "40", 10);

const setPath = join(projectPath, ".peon", "evaluation", "retrieval-eval.json");
const config = loadPeonConfig();

async function genQuery(belief) {
  const sys =
    "Write ONE natural, specific question a user would ask whose answer is exactly the given memory belief. " +
    "Include a distinctive detail from it so the question is unambiguous, but phrase it as a real user would " +
    "(do NOT quote the belief verbatim). Output ONLY the question.";
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.processingModel, temperature: 0.3, messages: [
      { role: "system", content: sys },
      { role: "user", content: belief.content }
    ] })
  });
  const j = await r.json();
  return (j.choices?.[0]?.message?.content ?? "").trim().replace(/^["']|["']$/g, "");
}

async function build() {
  const store = await PeonMemoryStore.open({ projectPath });
  const all = (await store.listMemoryRecords()).filter((r) => r.status === "active");
  // Sample spread across types, prefer substantial content.
  const pool = all.filter((r) => r.content.length > 30);
  const step = Math.max(1, Math.floor(pool.length / N));
  const sample = pool.filter((_, i) => i % step === 0).slice(0, N);
  const items = [];
  for (const belief of sample) {
    const query = await genQuery(belief).catch(() => "");
    if (query) items.push({ query, goldId: belief.id, goldContent: belief.content.slice(0, 100) });
  }
  mkdirSync(join(projectPath, ".peon", "evaluation"), { recursive: true });
  writeFileSync(setPath, JSON.stringify({ projectPath, builtFrom: all.length, items }, null, 2));
  console.log(`built ${items.length} labeled queries → ${setPath}`);
  return items;
}

async function run(items) {
  const store = await PeonMemoryStore.open({ projectPath });
  const K = [1, 3, 5, 10];
  const recallAt = Object.fromEntries(K.map((k) => [k, 0]));
  let mrr = 0, ndcg = 0, found = 0;
  for (const it of items) {
    const ranked = await store.rankRecords(it.query, { limit: 20 });
    const rank = ranked.findIndex((r) => r.record.id === it.goldId) + 1; // 1-based, 0 = not found
    if (rank > 0) {
      found++;
      mrr += 1 / rank;
      if (rank <= 10) ndcg += 1 / Math.log2(rank + 1);
      for (const k of K) if (rank <= k) recallAt[k] += 1;
    }
  }
  const n = items.length;
  const pct = (x) => (100 * x / n).toFixed(1) + "%";
  console.log(`\n  Retrieval eval — ${n} queries (gold belief per query), current ranker:`);
  for (const k of K) console.log(`    Recall@${k}: ${pct(recallAt[k])}`);
  console.log(`    MRR (top-20): ${(mrr / n).toFixed(3)}`);
  console.log(`    nDCG@10:      ${(ndcg / n).toFixed(3)}`);
  console.log(`    found in top-20: ${pct(found)}`);
  return { recallAt, mrr: mrr / n, ndcg: ndcg / n, found: found / n, n };
}

let items;
if (mode === "run") {
  if (!existsSync(setPath)) { console.error("no eval set; run 'build' first"); process.exit(1); }
  items = JSON.parse(readFileSync(setPath, "utf8")).items;
} else if (mode === "build") {
  items = await build();
} else {
  items = existsSync(setPath) ? JSON.parse(readFileSync(setPath, "utf8")).items : await build();
}
if (mode !== "build") await run(items);
