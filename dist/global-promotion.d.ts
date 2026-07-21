import type { MemoryRecord, MemoryType } from "./types.js";
/**
 * Auto-promotion policy: which project beliefs should also live in GLOBAL memory
 * so any project can recall them, not just the one that learned them.
 *
 * The bar is deliberately high to keep project isolation the default (a locked
 * product decision). Only two things cross the line:
 *   1. Records the processor (or a human) explicitly scoped "global" — the
 *      AI's own judgment that knowledge is cross-cutting (infra, environment,
 *      external services, reusable references like cluster docs).
 *   2. `fact` records — facts about the user/environment/tooling are
 *      cross-cutting by nature.
 *
 * Project-internal noise (decisions about THIS repo, file artifacts, timeline
 * events, project-specific preferences) intentionally stays project-scoped.
 */
export declare const DEFAULT_PROMOTABLE_TYPES: readonly MemoryType[];
export interface PromotionPolicy {
    /** Types always promoted regardless of explicit scope. */
    promotableTypes?: readonly MemoryType[];
}
/** A pure predicate — true if this record should be copied into global memory. */
export declare function isGloballyPromotable(record: MemoryRecord, policy?: PromotionPolicy): boolean;
/** Select the subset of project records that should be promoted to global memory. */
export declare function selectGloballyPromotable(records: readonly MemoryRecord[], policy?: PromotionPolicy): MemoryRecord[];
