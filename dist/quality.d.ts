import type { MemoryRecord } from "./types.js";
export interface DuplicateMemoryRecord {
    duplicateId: string;
    keptId: string;
    key: string;
}
export interface DeduplicateMemoryRecordsResult {
    records: MemoryRecord[];
    duplicates: DuplicateMemoryRecord[];
}
export interface MemoryConflict {
    entity: string;
    leftId: string;
    rightId: string;
    reason: string;
}
export interface StaleMemoryOptions {
    now?: Date;
    staleAfterDays?: number;
}
export interface MarkStaleMemoryRecordsResult {
    records: MemoryRecord[];
    staleIds: string[];
}
export interface PromoteMemoryRecordsOptions {
    repeatedContent?: string[];
    importantTerms?: string[];
    repeatThreshold?: number;
    repeatBoost?: number;
    importantBoost?: number;
}
export interface PromotedMemoryRecord {
    id: string;
    reason: "repeated" | "important";
    importance: number;
}
export interface PromoteMemoryRecordsResult {
    records: MemoryRecord[];
    promoted: PromotedMemoryRecord[];
}
export interface QualityReportOptions extends StaleMemoryOptions, PromoteMemoryRecordsOptions {
}
export interface MemoryQualityReport {
    inputCount: number;
    outputCount: number;
    records: MemoryRecord[];
    duplicates: DuplicateMemoryRecord[];
    conflicts: MemoryConflict[];
    staleIds: string[];
    promotedIds: string[];
}
export interface MemoryQualityAuditSummary {
    inputCount: number;
    outputCount: number;
    removedDuplicateCount: number;
    conflictCount: number;
    staleCount: number;
    promotedCount: number;
    changedCount: number;
    unchangedCount: number;
    removedIds: string[];
    updatedIds: string[];
    retainedIds: string[];
}
export interface ApplyMemoryQualityReportResult {
    records: MemoryRecord[];
    audit: MemoryQualityAuditSummary;
}
export interface SerializedMemoryQualityReport {
    inputCount: number;
    outputCount: number;
    records: MemoryRecord[];
    duplicates: DuplicateMemoryRecord[];
    conflicts: MemoryConflict[];
    staleIds: string[];
    promotedIds: string[];
    audit: MemoryQualityAuditSummary;
}
export declare function deduplicateMemoryRecords(records: MemoryRecord[]): DeduplicateMemoryRecordsResult;
export interface DetectConflictOptions {
    /** Compare every pair (the original scan). Kept for equivalence testing. */
    exhaustive?: boolean;
    /** Override the ubiquitous-entity bucket cap (default MAX_ENTITY_BUCKET). */
    maxEntityBucket?: number;
}
/** How many record pairs the last scan actually string-compared. */
export declare function conflictScanStats(): {
    pairsEvaluated: number;
};
/**
 * Conflicts require a shared entity, so only pairs that co-occur in some entity's
 * bucket can ever qualify. Indexing by entity skips the overwhelming majority of
 * pairs without touching a string; everything derived per record (normalized text,
 * token sets, entity maps) is computed once instead of once per pair.
 */
export declare function detectMemoryConflicts(records: MemoryRecord[], options?: DetectConflictOptions): MemoryConflict[];
export declare function markStaleMemoryRecords(records: MemoryRecord[], options?: StaleMemoryOptions): MarkStaleMemoryRecordsResult;
export declare function promoteMemoryRecords(records: MemoryRecord[], options?: PromoteMemoryRecordsOptions): PromoteMemoryRecordsResult;
export declare function applyMemoryQualityReport(records: MemoryRecord[], report: MemoryQualityReport): ApplyMemoryQualityReportResult;
export declare function summarizeMemoryQualityReport(report: MemoryQualityReport, records?: MemoryRecord[]): MemoryQualityAuditSummary;
export declare function serializeMemoryQualityReport(report: MemoryQualityReport): SerializedMemoryQualityReport;
export declare function createQualityReport(records: MemoryRecord[], options?: QualityReportOptions): MemoryQualityReport;
