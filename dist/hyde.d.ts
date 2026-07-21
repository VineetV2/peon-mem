import type { PeonConfig } from "./config.js";
import type { FetchLike } from "./reranker.js";
/**
 * HyDE — Hypothetical Document Embeddings (Gao et al., 2022).
 *
 * A short, vague query ("how do we handle retries?") often shares few tokens — and little
 * embedding mass — with the belief that actually answers it ("Route webhook retries through
 * the durable queue with exponential backoff"). HyDE closes that gap: a small LLM writes a
 * HYPOTHETICAL answer to the query, and we retrieve against THAT richer text instead of the
 * bare query. The hypothetical may be factually wrong — it doesn't matter; its job is to land
 * in the right neighborhood of the embedding/lexical space so the real, stored answer ranks up.
 *
 * We return an EXPANDED query = original query + hypothetical. Keeping the original terms means
 * lexical matching stays anchored on what the user literally asked, while the hypothetical adds
 * the vocabulary and semantic signal that pure query embedding lacks. Opt-in and fail-safe:
 * with no API key, AI disabled, or any error, it returns the original query untouched.
 */
export interface HydeOptions {
    config: PeonConfig;
    model?: string;
    fetchImpl?: FetchLike;
    /** Cap on the generated hypothetical (keeps prompt cost and noise down). Default 320. */
    maxChars?: number;
}
export interface HydeResult {
    /** original + hypothetical, for use as the retrieval query. Equals original on any failure. */
    expanded: string;
    /** the generated hypothetical answer alone (empty if generation was skipped/failed). */
    hypothetical: string;
}
export declare function expandQuery(query: string | undefined, options: HydeOptions): Promise<HydeResult>;
