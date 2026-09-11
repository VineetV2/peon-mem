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
    reason: "forced" | "threshold_reached" | "below_threshold" | "ai_disabled" | "missing_api_key" | "empty_memory" | "in_progress";
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
/** The model server took too long for this request. A smaller chunk may fit. */
export declare class ModelTimeoutError extends Error {
    name: string;
}
/** The model server's context window cut the prompt. A smaller chunk may fit. */
export declare class PromptTruncatedError extends Error {
    name: string;
}
/** Test hook: shorten the tracing thresholds. */
export declare function setPhaseTraceTimings(slowMs: number, everyMs: number): void;
/** Test hook: forget in-flight runs and the model slot pool. */
export declare function resetConsolidationScheduling(): void;
export declare class PeonMemoryProcessor {
    private readonly config;
    private readonly modelClient;
    constructor(options?: PeonMemoryProcessorOptions);
    /**
     * Consolidate the next chunk of this project's session log. A call that arrives while
     * another run for the project is queued or running waits for it, then takes the NEXT
     * chunk (the cursor has moved), so nothing is applied twice.
     */
    processMemory(input: ProcessMemoryInput): Promise<ProcessMemoryResult>;
    private consolidate;
    private consolidateTraced;
    maybeProcessMemory(input: MaybeProcessMemoryInput): Promise<MaybeProcessMemoryResult>;
    /** The answer for a trigger that arrives while this project's backlog is already being handled. */
    private inProgress;
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
/**
 * Did the model server silently truncate the prompt?
 *
 * OpenAI-compatible servers report usage.prompt_tokens: what the model actually read.
 * Ollama, at its 4096-token default, reports exactly 4096 for a ~17K-token prompt.
 *
 * The estimate comes from estimatePromptTokensForTruncation, and the threshold has to
 * respect how rough it is. For English that estimate is chars/4, which OVER-estimates
 * (real text runs ~5.5 chars/token), so an untruncated prompt still reports ~0.73 of
 * it. A truncated one reports ~0.24. Below 0.5 is unambiguous: reaching it without
 * truncation would take 8+ chars per token. Small prompts are ignored, where
 * estimation noise is a large share of the total.
 */
export declare function detectPromptTruncation(estimatedPromptTokens: number, reportedPromptTokens: number | undefined): boolean;
/**
 * Prompt size estimate for detectPromptTruncation ONLY. estimateTokens (chars/4) stays
 * the cost/reporting estimate; this one exists because chars/4 undercounts token-dense
 * scripts, which let a truncated CJK prompt pass as untruncated.
 *
 * The detector flags reported/estimated < 0.5, so each weight has to sit between two
 * limits: high enough that a truncated prompt falls below 0.5, and at most ~2x the
 * MOST efficient tokenizer's rate, or an untruncated prompt falls below 0.5 too. That
 * false positive is the worse failure: the session is refused on every retry.
 *
 * - ASCII, 1/4 per char: unchanged, so English behaves exactly as before (chars/4
 *   over-counts English ~1.4x; measured untruncated ratio 0.73, truncated 0.24).
 * - Han, kana, hangul, bopomofo, CJK and fullwidth punctuation, 0.75 per char: efficient
 *   tokenizers run ~0.45-0.6 tokens per CJK char, giving an untruncated ratio of 0.6-0.8.
 *   Qwen2.5 on Ollama runs ~0.65, so a truncated CJK prompt now reads well under 0.5.
 * - Any other non-ASCII, 0.35 per char: Cyrillic, Greek, Arabic, accented Latin and the
 *   like pack into ~0.22-0.35 tokens per char on large-vocabulary tokenizers. A flat 0.75
 *   here would read an untruncated Russian log at ~0.31 and block it forever.
 *
 * Iterates code points, so an astral character (CJK Extension B, emoji) counts once.
 */
export declare function estimatePromptTokensForTruncation(text: string): number;
