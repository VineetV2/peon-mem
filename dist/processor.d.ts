import { type PeonConfig } from "./config.js";
import type { ProcessedMemory } from "./types.js";
export interface MemoryModelResult {
    content: string;
    model: string;
    estimatedTokens: number;
}
export interface MemoryModelClient {
    processMemory(input: {
        rawMemory: string;
        existingMemory?: string;
        config: PeonConfig;
        reason: string;
    }): Promise<MemoryModelResult>;
}
export interface ProcessMemoryInput {
    projectPath: string;
    reason?: string;
    aiResult?: ProcessedMemory;
}
/** What a single consolidation run actually did — surfaced for observability. */
export interface ConsolidationStats {
    operationsEmitted: number;
    superseded: number;
    obsoleted: number;
    recordsAdded: number;
    merged: number;
}
export interface ProcessMemoryResult {
    status: "processed";
    model: string;
    estimatedTokens: number;
    applied: ProcessedMemory;
    stats: ConsolidationStats;
    /** True when the raw delta was capped this run (a backlog chunk) — more remains to drain. */
    capped: boolean;
}
export interface MaybeProcessMemoryInput {
    projectPath: string;
    trigger: string;
    force?: boolean;
    aiResult?: ProcessedMemory;
}
export interface ProcessingDecision {
    action: "process" | "skip";
    reason: "forced" | "threshold_reached" | "below_threshold" | "ai_disabled" | "missing_api_key" | "empty_memory";
    trigger: string;
    rawChars: number;
    newChars: number;
    flushMinChars: number;
    estimatedTokens: number;
}
export type MaybeProcessMemoryResult = {
    status: "processed";
    decision: ProcessingDecision;
    result: ProcessMemoryResult;
} | {
    status: "skipped";
    decision: ProcessingDecision;
};
export interface PeonMemoryProcessorOptions {
    config?: PeonConfig;
    modelClient?: MemoryModelClient;
}
export declare class PeonMemoryProcessor {
    private readonly config;
    private readonly modelClient;
    constructor(options?: PeonMemoryProcessorOptions);
    processMemory(input: ProcessMemoryInput): Promise<ProcessMemoryResult>;
    maybeProcessMemory(input: MaybeProcessMemoryInput): Promise<MaybeProcessMemoryResult>;
}
export declare function decideProcessing(input: {
    rawChars: number;
    lastProcessedRawChars: number;
    flushMinChars: number;
    trigger: string;
    force: boolean;
    aiMode: PeonConfig["aiMode"];
    hasApiKey: boolean;
    hasManualAiResult: boolean;
}): ProcessingDecision;
export declare class OpenRouterMemoryModelClient implements MemoryModelClient {
    processMemory(input: {
        rawMemory: string;
        existingMemory?: string;
        config: PeonConfig;
        reason: string;
    }): Promise<MemoryModelResult>;
}
export declare function parseProcessedMemory(content: string): ProcessedMemory;
