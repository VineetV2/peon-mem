import type { MemoryRecord } from "./types.js";
/**
 * The autonomous brain — a "sleep cycle" of curation the daemon runs on its own.
 * Pure and testable: every step takes a belief set and returns a new one plus a
 * log of what it did. Nothing is destroyed — losers/merged/compressed beliefs are
 * demoted to the `archived` tier (recoverable, searchable, never injected).
 *
 * The LLM-dependent step (topic compression) takes an injected `summarize`
 * callback so the orchestration stays unit-testable without a model.
 */
export type BrainActionType = "reinforce" | "resolve_conflict" | "merge_duplicate" | "compress_cluster";
export interface BrainAction {
    type: BrainActionType;
    detail: string;
    affectedIds: string[];
}
export interface SleepCycleResult {
    records: MemoryRecord[];
    actions: BrainAction[];
}
/**
 * Reinforcement: beliefs recalled since the last pass get stronger and a fresh
 * lastRecalledAt; everything else relaxes slightly toward its importance anchor.
 * This is the "use it or lose it" signal — except nothing is lost, it only
 * decides what stays detailed in working memory vs. eligible for compression.
 */
export declare function reinforce(records: readonly MemoryRecord[], recalledIds: readonly string[], now: string, protectGlobalScope?: boolean): SleepCycleResult;
/**
 * Resolve detected conflicts autonomously: the higher-confidence belief wins,
 * ties break to the newer one; the loser is archived (recoverable), not deleted.
 */
export declare function resolveConflicts(records: readonly MemoryRecord[], now: string, protectGlobalScope?: boolean): SleepCycleResult;
/**
 * Auto-merge near-duplicate beliefs: fold the weaker into the stronger (union
 * entities, keep the higher scores), archiving the raw copy via the merge helper's
 * delete — here we instead ARCHIVE the dropped record so nothing is lost.
 */
export declare function autoMergeDuplicates(records: readonly MemoryRecord[], now: string, threshold?: number, protectGlobalScope?: boolean): SleepCycleResult;
export interface TopicCluster {
    entity: string;
    members: MemoryRecord[];
}
/** Group ACTIVE, non-protected beliefs by their dominant entity. */
export declare function findTopicClusters(records: readonly MemoryRecord[], minSize: number, protectGlobalScope?: boolean): TopicCluster[];
export type Summarizer = (cluster: TopicCluster) => Promise<string>;
/**
 * Compress topic clusters: when many beliefs share an entity, roll them into one
 * summary belief (via the injected LLM `summarize`) and archive the raw detail,
 * linked by summaryOf/summarizedBy. Working memory shrinks; nothing is lost.
 */
export declare function compressTopicClusters(records: readonly MemoryRecord[], summarize: Summarizer, now: string, options?: {
    minClusterSize?: number;
    maxClusters?: number;
    protectGlobalScope?: boolean;
    makeId: (entity: string) => string;
}): Promise<SleepCycleResult>;
export interface SleepCycleOptions {
    recalledIds?: string[];
    now: string;
    summarize?: Summarizer;
    minClusterSize?: number;
    maxClusters?: number;
    /** Set false when curating the GLOBAL brain — there, global beliefs are the working set. */
    protectGlobalScope?: boolean;
    makeSummaryId: (entity: string) => string;
}
/**
 * One full autonomous pass: reinforce → resolve conflicts → merge duplicates →
 * compress topic clusters. Returns the curated belief set and an action log.
 * The caller snapshots a backup BEFORE applying this — every step is recoverable.
 */
export declare function runSleepCycle(records: readonly MemoryRecord[], options: SleepCycleOptions): Promise<SleepCycleResult>;
