import type { PeonConfig } from "./config.js";
import type { FetchLike } from "./reranker.js";
/**
 * Model-grade DOMAIN entity extraction. The deterministic resolver (entities.ts) reliably catches
 * files/symbols and obvious products/proper-nouns, but it misses the domain knowledge that matters
 * most for associative recall — people, papers, methods, datasets, organizations stated in prose
 * ("the professor's MaskSQL idea", "AskData on BIRD"). The consolidation panel's one firm
 * conclusion was that entity extraction is THE place model quality earns its keep (unlike
 * consolidation fidelity, where it's marginal). So this runs ONE batched LLM pass over the belief
 * snippets and returns the named entities per snippet, to be MERGED with the deterministic set.
 *
 * Strictly optional + fail-safe: no API key, AI disabled, empty input, or any LLM/parse failure
 * returns an empty map and the caller keeps the deterministic entities. Injectable fetch for tests.
 */
export interface ExtractItem {
    /** Stable key the caller maps results back by (e.g. normalized content). */
    key: string;
    content: string;
}
export interface ExtractOptions {
    config: PeonConfig;
    model?: string;
    fetchImpl?: FetchLike;
    /** Max snippets per call + per-snippet char cap (keeps the prompt and cost bounded). */
    maxItems?: number;
    snippetChars?: number;
}
export declare function extractDomainEntitiesViaModel(items: ExtractItem[], options: ExtractOptions): Promise<Map<string, string[]>>;
/** Tolerant parse of `[{n, entities:[...]}, ...]` from a model response. */
export declare function parseEntityArray(content: string): Array<{
    n: number;
    entities: string[];
}>;
