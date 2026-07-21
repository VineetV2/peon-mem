import { type RankedMemoryRecord } from "./retrieval.js";
import type { MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from "./types.js";
export interface BuildContextInjectionOptions {
    projectResults: RankedMemoryRecord[];
    globalRecords: MemoryRecord[];
    query?: string;
    maxChars: number;
    includeInactive?: boolean;
    now?: Date | string | number;
}
export interface SelectedInjectionMetadata {
    id: string;
    scope: MemoryScope;
    type: MemoryType;
    status: MemoryStatus;
    score: number;
    whySelected: string;
    source: MemoryRecord["source"];
    chars: number;
}
export type OmittedInjectionReason = "suppressed_status" | "max_chars";
export interface OmittedInjectionMetadata {
    id: string;
    scope: MemoryScope;
    type: MemoryType;
    status: MemoryStatus;
    reason: OmittedInjectionReason;
    score: number;
}
export interface ContextInjection {
    preview: string;
    selected: SelectedInjectionMetadata[];
    omitted: OmittedInjectionMetadata[];
    totalChars: number;
    maxChars: number;
}
export declare function buildContextInjection(options: BuildContextInjectionOptions): ContextInjection;
export declare function redactSecrets(value: string): string;
