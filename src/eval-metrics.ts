/**
 * Standard ranked-retrieval metrics for the query-driven eval harness. Pure + deterministic so
 * they're unit-testable; the harness (scripts/eval-retrieval-labeled.mjs) feeds them a ranked list
 * of belief ids and a relevance-judged set, and reports graph-off vs graph-on.
 *
 * All take `retrieved` (ranked ids, best first) and `relevant` (the judged-relevant id set).
 */

/** Fraction of the relevant items found in the top-k. 1 when there are no relevant items (nothing to miss). */
export function recallAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  let hits = 0;
  for (const id of retrieved.slice(0, Math.max(0, k))) if (relevant.has(id)) hits += 1;
  return hits / relevant.size;
}

/** Reciprocal rank of the FIRST relevant hit (1/rank), 0 if none retrieved. Mean over queries = MRR. */
export function reciprocalRank(retrieved: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < retrieved.length; i += 1) if (relevant.has(retrieved[i])) return 1 / (i + 1);
  return 0;
}

/** Normalized DCG at k with binary relevance: DCG/IDCG. 1 when there are no relevant items. */
export function ndcgAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 1;
  const top = retrieved.slice(0, Math.max(0, k));
  let dcg = 0;
  for (let i = 0; i < top.length; i += 1) if (relevant.has(top[i])) dcg += 1 / Math.log2(i + 2);
  const ideal = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < ideal; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

export interface QueryScore {
  recall: number;
  rr: number;
  ndcg: number;
}

export function scoreQuery(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): QueryScore {
  return { recall: recallAtK(retrieved, relevant, k), rr: reciprocalRank(retrieved, relevant), ndcg: ndcgAtK(retrieved, relevant, k) };
}

export interface AggregateScore {
  queries: number;
  recallAtK: number;
  mrr: number;
  ndcgAtK: number;
}

/** Mean of per-query scores → Recall@K, MRR, nDCG@K over the whole labeled set. */
export function aggregate(scores: readonly QueryScore[]): AggregateScore {
  const n = scores.length;
  if (n === 0) return { queries: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0 };
  const sum = scores.reduce((a, s) => ({ recall: a.recall + s.recall, rr: a.rr + s.rr, ndcg: a.ndcg + s.ndcg }), { recall: 0, rr: 0, ndcg: 0 });
  return { queries: n, recallAtK: sum.recall / n, mrr: sum.rr / n, ndcgAtK: sum.ndcg / n };
}
