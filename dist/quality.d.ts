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
export declare function detectMemoryConflicts(records: MemoryRecord[]): MemoryConflict[];
export declare function markStaleMemoryRecords(records: MemoryRecord[], options?: StaleMemoryOptions): MarkStaleMemoryRecordsResult;
export declare function promoteMemoryRecords(records: MemoryRecord[], options?: PromoteMemoryRecordsOptions): PromoteMemoryRecordsResult;
export declare function applyMemoryQualityReport(records: MemoryRecord[], report: MemoryQualityReport): ApplyMemoryQualityReportResult;
export declare function summarizeMemoryQualityReport(report: MemoryQualityReport, records?: MemoryRecord[]): MemoryQualityAuditSummary;
export declare function serializeMemoryQualityReport(report: MemoryQualityReport): SerializedMemoryQualityReport;
export declare function createQualityReport(records: MemoryRecord[], options?: QualityReportOptions): MemoryQualityReport;
