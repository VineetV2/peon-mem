import type { PeonConfig } from "./config.js";
import type { RankedMemoryRecord } from "./retrieval.js";

/**
 * Stage two of two-stage retrieval. The lexical+semantic ranker (RRF) is a high-RECALL
 * first pass: cheap, deterministic, surfaces everything plausibly relevant. This reranker
 * is the high-PRECISION second pass: a small, fast LLM (flash-lite) reads the actual query
 * and the candidate snippets and reorders the top-K by true relevance — catching meaning
 * that token overlap and cosine miss (negation, intent, the right sense of an ambiguous term).
 *
 * It is strictly optional and degrades gracefully: with no API key, AI disabled, an empty
 * query, too few candidates, or any LLM/parse failure, it returns the input order unchanged.
 * Only the top-K head is reranked; the tail is left in its original order and appended, so a
 * truncated or partial model response can never drop or duplicate a candidate.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface RerankOptions {
  config: PeonConfig;
  /** How many of the top candidates to rerank. Default 20. The rest keep their order. */
  topK?: number;
  /** Override the rerank model. Defaults to the (cheap) processing model. */
  model?: string;
  /** Injectable fetch — defaults to global fetch. Lets tests run without a network. */
  fetchImpl?: FetchLike;
  /** Per-snippet character cap fed to the model (keeps the prompt — and cost — small). Default 240. */
  snippetChars?: number;
}

const DEFAULT_TOP_K = 20;
const DEFAULT_SNIPPET_CHARS = 240;

export async function rerankRecords(
  query: string | undefined,
  records: RankedMemoryRecord[],
  options: RerankOptions
): Promise<RankedMemoryRecord[]> {
  const { config } = options;
  const q = (query ?? "").trim();
  // Cheap exits — never pay an LLM call when it cannot help.
  if (!q || records.length < 2) return records;
  if (config.aiMode === "off" || !config.openRouterApiKey) return records;

  const topK = Math.max(2, Math.trunc(options.topK ?? DEFAULT_TOP_K));
  const snippetChars = Math.max(40, Math.trunc(options.snippetChars ?? DEFAULT_SNIPPET_CHARS));
  const head = records.slice(0, topK);
  const tail = records.slice(topK);
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch) return records;

  const numbered = head
    .map((item, i) => `${i + 1}. [${item.record.type}] ${truncate(item.record.content, snippetChars)}`)
    .join("\n");
  const system =
    "You are a precision reranker for a memory system. Given a user query and a numbered list " +
    "of candidate memory snippets, decide which snippets best help answer the query. " +
    "Return ONLY a JSON array of the candidate numbers, ordered from most to least relevant. " +
    "Include every number exactly once. No prose, no code fences.";
  const user = `Query: ${q}\n\nCandidates:\n${numbered}\n\nJSON array of numbers (most relevant first):`;

  try {
    const response = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0
      })
    });
    if (!response.ok) return records;
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content ?? "";
    const order = parseOrder(content, head.length);
    if (order.length === 0) return records;

    // Apply the model's order to the head, then append any head items it omitted (in their
    // original order), then the untouched tail. Guarantees a permutation of the input.
    const seen = new Set<number>();
    const reorderedHead: RankedMemoryRecord[] = [];
    for (const n of order) {
      const idx = n - 1;
      if (idx >= 0 && idx < head.length && !seen.has(idx)) {
        seen.add(idx);
        reorderedHead.push(head[idx]);
      }
    }
    for (let i = 0; i < head.length; i++) if (!seen.has(i)) reorderedHead.push(head[i]);
    return [...reorderedHead, ...tail];
  } catch {
    return records; // any failure → first-pass order, never worse than before
  }
}

/** Extract the leading JSON array of positive integers from a model response, tolerant of stray prose/fences. */
export function parseOrder(content: string, max: number): number[] {
  const match = content.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((n) => (typeof n === "number" ? Math.trunc(n) : Number.parseInt(String(n), 10)))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= max);
  } catch {
    return [];
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
