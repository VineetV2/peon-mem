#!/usr/bin/env node
// LongMemEval harness for Peon (Node-only, via OpenRouter).
//
// Per question: feed the timestamped haystack into a fresh isolated Peon store,
// consolidate into beliefs, retrieve context for the question, let a reader LLM
// answer from ONLY that memory, then grade with gpt-4o using LongMemEval's exact
// per-category prompts. Reports overall + per-category accuracy.
//
//   node scripts/longmemeval-eval.mjs <dataset.json> [N_per_type] [readerModel]
//
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeonMemoryStore } from "../dist/memory-store.js";
import { PeonMemoryProcessor } from "../dist/processor.js";
import { loadPeonConfig } from "../dist/config.js";
import { rerankRecords } from "../dist/reranker.js";
import { expandQuery } from "../dist/hyde.js";

const [, , dataPath, perTypeArg, readerArg, modeArg] = process.argv;
const perType = Number.parseInt(perTypeArg ?? "3", 10);
const READER = readerArg ?? "openai/gpt-4o";
const MODE = modeArg ?? "beliefs"; // "beliefs" = consolidate first; "raw" = rank raw episodic turns
const RERANK = process.env.PEON_RERANK === "1"; // stage-two LLM reranker (raw mode only)
const HYDE = process.env.PEON_HYDE === "1";     // hypothetical-document query expansion (raw mode only)
const GRAPH = process.env.PEON_GRAPH === "1";   // entity-graph 1-hop expansion (raw mode only)
const JUDGE = "openai/gpt-4o-2024-08-06";
const KEY = loadPeonConfig().openRouterApiKey;
const processor = new PeonMemoryProcessor();

async function chat(model, messages, temperature = 0) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature, messages })
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      return (j.choices?.[0]?.message?.content ?? "").trim();
    } catch (e) { await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); }
  }
  return "";
}

// ── Peon: ingest haystack → (consolidate OR keep raw) → retrieve ──
async function peonMemoryFor(q) {
  const projectPath = mkdtempSync(join(tmpdir(), "lme-"));
  try {
    const store = await PeonMemoryStore.open({ projectPath });
    if (MODE === "raw") {
      // Index each raw turn as an episodic record, then rank with Peon's ranker.
      const records = [];
      for (let s = 0; s < q.haystack_sessions.length; s++) {
        const date = q.haystack_dates?.[s] ?? new Date().toISOString();
        for (const turn of q.haystack_sessions[s]) {
          if (!turn?.content) continue;
          const content = `[${date}] ${turn.role}: ${turn.content}`;
          records.push({ id: `t${records.length}`, type: "fact", content, normalized: content.toLowerCase(),
            scope: "project", status: "active", score: { importance: 0.5, confidence: 0.6 },
            source: { kind: "manual" }, entities: [], createdAt: date, updatedAt: date });
        }
      }
      await store.replaceMemoryRecords(records);
      // HyDE: retrieve against a hypothetical answer to the question, not the bare question.
      const retrievalQuery = HYDE ? (await expandQuery(q.question, { config: loadPeonConfig() })).expanded : q.question;
      let ranked = await store.rankRecords(retrievalQuery, { limit: RERANK ? 30 : 15, expandGraph: GRAPH });
      if (RERANK) {
        // Stage two: LLM reranks the recall set, then keep the top 15 for the reader.
        ranked = (await rerankRecords(q.question, ranked, { config: loadPeonConfig(), topK: 30 })).slice(0, 15);
      }
      return ranked.map((r) => r.record.content).join("\n");
    }
    // beliefs / blended mode: real Peon — record, consolidate, retrieve distilled beliefs.
    // "blended" additionally turns on the episodic layer (raw turns) to recover the detail
    // consolidation compresses away — the high-recall complement to the belief layer.
    const session = await store.startSession({ client: "lme" });
    for (let s = 0; s < q.haystack_sessions.length; s++) {
      const date = q.haystack_dates?.[s] ?? "";
      for (const turn of q.haystack_sessions[s]) {
        if (turn?.content) await store.recordMessage({ sessionId: session.id, role: turn.role === "assistant" ? "assistant" : "user", content: `[${date}] ${turn.content}` });
      }
    }
    await store.endSession({ sessionId: session.id });
    await processor.processMemory({ projectPath, reason: "lme" });
    const ctx = await store.getContext({ query: q.question, maxChars: 6000, includeEpisodes: MODE === "blended" });
    return [ctx.summary, ctx.memories, ctx.decisions, ctx.preferences, ctx.openQuestions, ctx.artifacts, ctx.timeline, ctx.episodes].filter((t) => t && t.trim()).join("\n\n");
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
  }
}

async function read(question, questionDate, memory) {
  const sys = "You answer a question using ONLY the memory below, which was recalled from the user's past conversations. " +
    "Be concise and specific. If the memory does not contain enough information to answer, reply exactly: \"I don't know.\"";
  return chat(READER, [
    { role: "system", content: sys },
    { role: "user", content: `Today's date: ${questionDate}\n\nMemory:\n${memory || "(empty)"}\n\nQuestion: ${question}\n\nAnswer:` }
  ]);
}

// LongMemEval's exact judge prompts (from src/evaluation/evaluate_qa.py).
function judgePrompt(task, question, answer, response, abstention) {
  if (abstention) return `I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: ${question}\n\nExplanation: ${answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  if (["single-session-user", "single-session-assistant", "multi-session"].includes(task))
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "temporal-reasoning")
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors, the model's response is still correct.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "knowledge-update")
    return `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: ${question}\n\nCorrect Answer: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  if (task === "single-session-preference")
    return `I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: ${question}\n\nRubric: ${answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
  return `Question: ${question}\nCorrect Answer: ${answer}\nModel Response: ${response}\nIs the model response correct? Answer yes or no only.`;
}

async function grade(q, hyp) {
  const abstention = String(q.question_id).endsWith("_abs");
  const out = await chat(JUDGE, [{ role: "user", content: judgePrompt(q.question_type, q.question, q.answer, hyp, abstention) }]);
  return /^\s*yes/i.test(out);
}

// ── main ──
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const byType = {};
for (const q of data) (byType[q.question_type] ??= []).push(q);
const subset = Object.values(byType).flatMap((arr) => arr.slice(0, perType));
console.log(`LongMemEval: ${subset.length} questions (${perType}/type) · mode=${MODE} · reader=${READER} · judge=${JUDGE}\n`);

const perCat = {};
let correct = 0, done = 0;
for (const q of subset) {
  const mem = await peonMemoryFor(q).catch(() => "");
  const hyp = await read(q.question, q.question_date, mem);
  const ok = await grade(q, hyp);
  const cat = q.question_type + (String(q.question_id).endsWith("_abs") ? "(abs)" : "");
  (perCat[cat] ??= { n: 0, ok: 0 }).n++;
  if (ok) { perCat[cat].ok++; correct++; }
  done++;
  process.stdout.write(`\r  scored ${done}/${subset.length} · running acc ${(100 * correct / done).toFixed(1)}%   `);
}
console.log(`\n\n  === RESULTS ===`);
console.log(`  Overall accuracy: ${(100 * correct / subset.length).toFixed(1)}%  (${correct}/${subset.length})`);
console.log(`  By category:`);
for (const [cat, v] of Object.entries(perCat).sort()) console.log(`    ${cat.padEnd(28)} ${(100 * v.ok / v.n).toFixed(0).padStart(3)}%  (${v.ok}/${v.n})`);
