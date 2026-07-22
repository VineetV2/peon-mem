import { type EmbeddingVector } from "./embeddings.js";
import type { MemoryRecord, MemoryType } from "./types.js";
export type RetrievalReasonKind = "query_term" | "entity" | "file" | "type" | "quality" | "recency" | "status" | "semantic";
export interface RetrievalReason {
    kind: RetrievalReasonKind;
    label: string;
    score: number;
}
export interface RankedMemoryRecord {
    record: MemoryRecord;
    score: number;
    reasons: RetrievalReason[];
    explanation: string;
}
export interface SemanticRetrievalInput {
    /** Embedding of the query string. */
    queryVector: EmbeddingVector;
    /** Record id → its stored embedding vector. */
    vectorById: Map<string, EmbeddingVector>;
    /** How strongly cosine similarity counts toward the final score. Default 6. */
    weight?: number;
    /** Cosine similarities below this contribute nothing (filters noise). Default 0.15. */
    minSimilarity?: number;
}
export interface RetrievalOptions {
    now?: Date | string | number;
    limit?: number;
    typeWeights?: Partial<Record<MemoryType, number>>;
    /** When provided (and a query is given), blends semantic similarity into ranking. */
    semantic?: SemanticRetrievalInput;
    /** Per-record entity-graph activation (id → score). Fused as a signal AND admits an
     *  associatively-activated belief through the relevance gate, so a strong association can
     *  enter the top-K instead of being appended after the direct hits. See computeGraphActivation. */
    graphActivation?: Map<string, number>;
}
export interface ContextSelectionOptions {
    maxChars: number;
    recordFormatter?: (item: RankedMemoryRecord) => string;
}
export interface ContextSelection {
    records: RankedMemoryRecord[];
    omitted: RankedMemoryRecord[];
    totalChars: number;
    maxChars: number;
}
/**
 * Hybrid retrieval by Reciprocal Rank Fusion. Each signal (lexical, semantic,
 * quality, recency, reinforcement strength) ranks the relevance-gated candidates
 * independently; we fuse by Σ 1/(k+rank). RRF is weight-free — it removes the
 * fragile hand-tuned score constants by comparing RANKS, which are commensurable
 * across signals where raw scores are not. Pinned beliefs are boosted; archived/
 * superseded are excluded by default (they are the long-term tier, not working memory).
 */
export declare function rankMemoryRecords(records: MemoryRecord[], query: string | undefined, options?: RetrievalOptions): RankedMemoryRecord[];
export declare function selectMemoryRecordsForContext(rankedRecords: RankedMemoryRecord[], options: ContextSelectionOptions): ContextSelection;
/** Default trade-off: 0.7 weight on relevance, 0.3 on novelty. Tuned for coverage without losing the top hit. */
export declare const DEFAULT_MMR_LAMBDA = 0.7;
/**
 * Re-order ranked records by Maximal Marginal Relevance so the injected block has
 * COVERAGE instead of five paraphrases of the same belief. Each pick maximizes
 *   λ·relevance − (1−λ)·maxSimilarity(candidate, alreadyPicked)
 * Relevance is the record's existing fused score (max-normalized to [0,1] within the
 * set); similarity is lexical Jaccard over content+entity tokens — cheap, deterministic,
 * and embedding-free so it works in pure local-first mode. The single most relevant
 * record is always selected first, so the top hit is never displaced by diversification.
 */
export declare function diversifyByMMR(records: RankedMemoryRecord[], lambda?: number): RankedMemoryRecord[];
export interface GraphExpandOptions {
    /** How many of the top ranked records seed the activation. Default 8. */
    seedDepth?: number;
    /** Max neighbours to pull in. Default 6. */
    maxNeighbors?: number;
    /** Global decay on the 1-hop spread (keeps neighbours supplementary). Default 0.5. */
    damping?: number;
    /** Weight for code-namespace entities vs domain (file/symbol co-occurrence is weaker signal). Default 0.4. */
    codeWeight?: number;
    /** Skip entities mentioned by more than this many beliefs — super-hub hairball guard. Default 40. */
    hubDegreeCap?: number;
}
/**
 * Entity-graph spreading activation (the associative-recall layer). Lexical/semantic ranking
 * finds beliefs that match the QUERY; this finds beliefs in the ANSWER's neighbourhood by
 * spreading activation from the top hits through shared entities, with three brain-like rules
 * the old flat 1-hop expander lacked:
 *   - DISTANCE DECAY — a global damping (λ) keeps neighbours below direct matches.
 *   - MULTI-SOURCE SUMMATION — a belief lit through several shared entities (or several seeds)
 *     accumulates activation, so it outranks one lit through a single weak link.
 *   - HUB DAMPING — rare entities transmit more activation (1/log₂(2+degree)); super-hubs
 *     (e.g. a file mentioned by 80 beliefs) are skipped so the graph isn't a hairball.
 * Domain entities (people/papers/concepts) spread more than code entities. Pure + deterministic.
 * Neighbours come back with small scores in their own band and are meant to be appended AFTER
 * the direct results, never displacing them.
 */
/**
 * Raw spreading activation: id → accumulated activation for beliefs in the seeds' entity
 * neighbourhood (excluding the seeds themselves). The associative substrate, shared by the
 * fused-ranking path (passed as RetrievalOptions.graphActivation) and the legacy append path
 * (expandByEntityGraph). Excludes seed ids so direct hits aren't double-counted.
 */
export declare function computeGraphActivation(seeds: RankedMemoryRecord[], pool: MemoryRecord[], options?: GraphExpandOptions): Map<string, number>;
/**
 * Entity-graph spreading activation, formatted as standalone neighbour records (legacy append
 * path + the unit tests). The fused-ranking path uses computeGraphActivation directly via
 * rankMemoryRecords' graphActivation option, which lets associations compete inside the top-K.
 */
export declare function expandByEntityGraph(seeds: RankedMemoryRecord[], pool: MemoryRecord[], options?: GraphExpandOptions): RankedMemoryRecord[];
/**
 * Stale-shadow demotion. Measured failure mode (token A/B, question x1): recall answered with a
 * SUPERSEDED architecture description because the old belief was still active, semantically strong,
 * and outranked the newer truth. When two active beliefs in the ranked window describe the same fact
 * — near-duplicate vectors, or moderately similar with a shared entity and the same type — but were
 * written in different eras, the older one is treated as a stale shadow of the newer: its score is
 * scaled down so the newer belief always outranks it. Nothing is deleted or re-statused here; real
 * supersession stays the consolidator's job. Pinned records are never demoted.
 */
export declare function demoteStaleShadows(ranked: RankedMemoryRecord[], vectorById: Map<string, EmbeddingVector> | undefined, options?: {
    scan?: number;
    hardSim?: number;
    softSim?: number;
    ageGapMs?: number;
    penalty?: number;
}): RankedMemoryRecord[];
