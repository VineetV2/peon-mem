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
export type FetchLike = (url: string, init: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
}>;
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
export declare function rerankRecords(query: string | undefined, records: RankedMemoryRecord[], options: RerankOptions): Promise<RankedMemoryRecord[]>;
/** Extract the leading JSON array of positive integers from a model response, tolerant of stray prose/fences. */
export declare function parseOrder(content: string, max: number): number[];
