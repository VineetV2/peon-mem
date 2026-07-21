/**
 * Standard ranked-retrieval metrics for the query-driven eval harness. Pure + deterministic so
 * they're unit-testable; the harness (scripts/eval-retrieval-labeled.mjs) feeds them a ranked list
 * of belief ids and a relevance-judged set, and reports graph-off vs graph-on.
 *
 * All take `retrieved` (ranked ids, best first) and `relevant` (the judged-relevant id set).
 */
/** Fraction of the relevant items found in the top-k. 1 when there are no relevant items (nothing to miss). */
export declare function recallAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number;
/** Reciprocal rank of the FIRST relevant hit (1/rank), 0 if none retrieved. Mean over queries = MRR. */
export declare function reciprocalRank(retrieved: readonly string[], relevant: ReadonlySet<string>): number;
/** Normalized DCG at k with binary relevance: DCG/IDCG. 1 when there are no relevant items. */
export declare function ndcgAtK(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number;
export interface QueryScore {
    recall: number;
    rr: number;
    ndcg: number;
}
export declare function scoreQuery(retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): QueryScore;
export interface AggregateScore {
    queries: number;
    recallAtK: number;
    mrr: number;
    ndcgAtK: number;
}
/** Mean of per-query scores → Recall@K, MRR, nDCG@K over the whole labeled set. */
export declare function aggregate(scores: readonly QueryScore[]): AggregateScore;
