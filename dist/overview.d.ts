import type { MemoryRecord } from "./types.js";
import type { SelectedInjectionMetadata } from "./injection.js";
/**
 * Pure assembly helpers for the cockpit Overview. The daemon fetches the raw
 * material (project records, global records, the A/B token log, the last
 * injection) and these functions distill it into the at-a-glance payload.
 */
export interface BeliefCounts {
    active: number;
    superseded: number;
    conflicts: number;
    stale: number;
    archived: number;
    summaries: number;
    pinned: number;
    total: number;
}
export declare function summarizeBeliefs(records: readonly MemoryRecord[]): BeliefCounts;
export interface ProjectSummary {
    projectPath: string;
    active: number;
}
/**
 * Drop accidental subdirectory brains: a project nested inside another known
 * project that holds NO active beliefs is an empty `.peon` from a session that
 * ran with a subdir as cwd. Real (non-empty) nested projects are kept — we never
 * merge memory, only hide empty noise.
 */
export declare function filterStrayProjects<T extends ProjectSummary>(projects: readonly T[]): T[];
export interface DuplicatePair {
    aId: string;
    aContent: string;
    bId: string;
    bContent: string;
    similarity: number;
}
/**
 * Flag near-duplicate ACTIVE beliefs of the same type — a nudge for the user to
 * merge, not an automatic action. Conservative threshold to avoid false alarms.
 */
export declare function detectDuplicates(records: readonly MemoryRecord[], options?: {
    threshold?: number;
    limit?: number;
}): DuplicatePair[];
export interface TokenSavings {
    onAvg: number;
    offAvg: number;
    onSessions: number;
    offSessions: number;
    savedPerSession: number;
}
export interface AbTokenRecord {
    projectPath?: string;
    peonEnabled?: boolean;
    totalTokens?: number;
}
/**
 * Compare Peon-on vs Peon-off session token totals for a project. Returns null
 * until BOTH arms have at least one session — a savings claim needs a baseline.
 */
export declare function computeTokenSavings(records: readonly AbTokenRecord[], projectPath: string): TokenSavings | null;
export interface InjectionItem {
    id: string;
    scope: string;
    type: string;
    content: string;
    score: number;
}
/**
 * Turn the injection's selected-id metadata into displayable items by joining
 * back to the records' content (project + global). Ids with no match are dropped.
 */
export declare function enrichInjection(selected: readonly SelectedInjectionMetadata[], records: readonly MemoryRecord[]): InjectionItem[];
