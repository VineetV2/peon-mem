import { type PeonConfig } from "./config.js";
import { type EmbeddingClient } from "./embeddings.js";
import type { MemoryQualityReport } from "./quality.js";
import { type MemoryPatch } from "./memory-mutations.js";
import { type BrainAction, type Summarizer } from "./brain.js";
import { type RankedMemoryRecord } from "./retrieval.js";
import { type ChangeEntry } from "./temporal.js";
import type { BrainInspection, MemoryRecord, MemoryType, PeonEvent, PeonRole, PeonSession, ProcessedMemory, ProcessingState, ProjectContext } from "./types.js";
/** Counts of how applyStructuredMemory mutated the brain — surfaced for observability. */
export interface ApplyMemoryStats {
    superseded: number;
    obsoleted: number;
    added: number;
}
export interface OpenMemoryStoreOptions {
    projectPath: string;
    memoryDirName?: string;
    config?: PeonConfig;
    /** Override the embedding client (null disables embeddings). Mainly for tests. */
    embeddingClient?: EmbeddingClient | null;
}
export interface StartSessionInput {
    client: string;
    cwd: string;
}
export interface RecordMessageInput {
    sessionId: string;
    role: PeonRole;
    content: string;
}
export interface RecordEventInput {
    sessionId: string;
    type: string;
    content: string;
}
export interface EndSessionInput {
    sessionId: string;
}
export interface GetContextInput {
    query?: string;
    maxChars?: number;
    /** Also retrieve over raw conversational turns (episodic layer) and include them in the context. */
    includeEpisodes?: boolean;
}
export declare class PeonMemoryStore {
    private readonly projectPath;
    private readonly memoryDir;
    private readonly embeddingClient;
    private readonly sessions;
    private embeddingStore?;
    private constructor();
    static open(options: OpenMemoryStoreOptions): Promise<PeonMemoryStore>;
    startSession(input: StartSessionInput): Promise<PeonSession>;
    /**
     * Rehydrate a session into memory if it isn't already known. Called by the
     * tools layer after resolving a sessionId from the durable session index, so
     * record/end operations succeed even after a daemon restart. Idempotent.
     */
    ensureSession(session: PeonSession): void;
    recordMessage(input: RecordMessageInput): Promise<PeonEvent>;
    recordEvent(input: RecordEventInput): Promise<PeonEvent>;
    endSession(input: EndSessionInput): Promise<PeonSession>;
    getContext(input?: GetContextInput): Promise<ProjectContext>;
    inspectBrain(input?: GetContextInput): Promise<BrainInspection>;
    listMemoryRecords(): Promise<MemoryRecord[]>;
    /** Serialize a read-modify-write transaction against this project's brain (see projectWriteLocks). */
    private withWriteLock;
    /**
     * Run a multi-step read-modify-write as ONE serialized critical section against this project's
     * brain — even across separate store instances in the process. Callers must NOT invoke other
     * locking mutators inside `fn` (the lock is not reentrant); use the lock-free internals
     * (applyProcessedMemory, mergeSimilarActiveRecords, replaceMemoryRecords) directly.
     */
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
    replaceMemoryRecords(records: MemoryRecord[]): Promise<void>;
    /** Edit a belief in place (content, scores, status, or pin). Returns the updated record, or null if unknown. */
    updateMemoryRecord(id: string, patch: MemoryPatch): Promise<MemoryRecord | null>;
    /** Delete a belief outright. Returns true if a record was removed. */
    deleteMemoryRecord(id: string): Promise<boolean>;
    /** Pin/unpin a belief. Returns the updated record, or null if unknown. */
    setMemoryRecordPinned(id: string, pinned: boolean): Promise<MemoryRecord | null>;
    /** Fold one belief into another. Returns the surviving record, or null if either id is unknown. */
    mergeMemoryRecords(keepId: string, dropId: string): Promise<MemoryRecord | null>;
    /**
     * Run one autonomous brain pass (the "sleep cycle"): snapshot a backup, then
     * reinforce / resolve conflicts / merge duplicates / compress topic clusters.
     * Every change is recoverable from the snapshot. Returns the actions taken.
     */
    runBrainPass(options?: {
        recalledIds?: string[];
        summarize?: Summarizer;
        minClusterSize?: number;
    }): Promise<BrainAction[]>;
    /** Archive a set of beliefs (recoverable) after snapshotting a backup. Returns how many were archived. */
    archiveRecords(ids: readonly string[], reason: string): Promise<number>;
    /** Recent autonomous actions the brain took — powers the cockpit "what the brain did" feed. */
    readBrainActions(limit?: number): Promise<Array<{
        at: string;
        actions: BrainAction[];
    }>>;
    private snapshotBackup;
    /** Restore the project's beliefs from the most recent backup snapshot. Returns true if restored. */
    restoreLatestBackup(): Promise<boolean>;
    /**
     * Rank memory records for a query using hybrid lexical + semantic retrieval.
     * The single retrieval entry point: embeds the query (if embeddings are on),
     * loads stored vectors, and blends cosine similarity into the lexical score.
     */
    /** Time-travel: the beliefs that were current as of `at`. */
    currentAsOf(at: string | number | Date): Promise<MemoryRecord[]>;
    /** Time-travel: the changelog (added / superseded / retired) over [from, to]. */
    changesBetween(from: string | number | Date, to: string | number | Date): Promise<ChangeEntry[]>;
    /**
     * EPISODIC retrieval — rank the raw conversational turns (not the consolidated beliefs) by
     * relevance to a query. Consolidation is lossy by design: it distills experience into durable
     * beliefs and drops episodic specifics ("the GPS was not functioning" becomes "interested in
     * GPS features"). For questions that hinge on those specifics, retrieving over the raw record
     * recovers the detail the belief layer compressed away. This is the high-recall episodic layer
     * that complements the high-precision belief layer; callers can blend both. Lexical-ranked
     * (raw turns carry no precomputed embeddings) and read-only — it never mutates the store.
     */
    rankEpisodes(query: string | undefined, options?: {
        limit?: number;
    }): Promise<RankedMemoryRecord[]>;
    rankRecords(query: string | undefined, options?: {
        limit?: number;
        expandGraph?: boolean;
    }): Promise<RankedMemoryRecord[]>;
    /**
     * Rank records WITHOUT mutating anything — uses only embeddings already on disk
     * (no sync, no recompute, no writes). For read-only cross-project recall, where
     * we must never modify another project's brain. An optional precomputed query
     * vector lets the caller embed the query once and reuse it across many projects.
     */
    rankRecordsReadonly(query: string | undefined, options?: {
        limit?: number;
        queryVector?: number[];
    }): Promise<RankedMemoryRecord[]>;
    private buildSemanticInput;
    writeQualityReport(report: MemoryQualityReport): Promise<void>;
    readRawMemory(maxChars?: number): Promise<string>;
    /**
     * Read only the raw events that arrived AFTER `afterEventId` (the delta cursor),
     * so consolidation processes new experience instead of re-reading a window.
     * Falls back to the full sliding window when the cursor is unset or no longer
     * present (e.g. logs rotated) — never silently skips events. The delta is capped
     * to `maxChars` (default 60k, env PEON_CONSOLIDATION_MAX_DELTA_CHARS); `lastEventId`
     * is the last INCLUDED event (the next cursor) and `capped` is true when the delta
     * was cut short — the caller must then keep the char-gate open so the rest drains.
     */
    readRawMemoryDelta(afterEventId?: string, maxChars?: number): Promise<{
        text: string;
        lastEventId?: string;
        capped: boolean;
    }>;
    applyProcessedMemory(memory: ProcessedMemory, source?: {
        reason?: string;
    }, modelEntities?: Map<string, string[]>): Promise<ApplyMemoryStats>;
    /**
     * Merge near-duplicate ACTIVE records by embedding similarity. Models sometimes
     * record the same belief twice (e.g. a supersede replacement AND a paraphrase in
     * decisions[]); lexical dedup misses these because the wording differs. With real
     * (API) embeddings this catches the paraphrase and keeps a single current truth.
     * No-op when embeddings are unavailable. supersededBy links to a merged-away id
     * are re-pointed at the surviving record so history stays intact.
     */
    mergeSimilarActiveRecords(records: MemoryRecord[], threshold?: number): Promise<{
        records: MemoryRecord[];
        merged: number;
    }>;
    readProcessingState(): Promise<ProcessingState>;
    writeProcessingState(state: ProcessingState): Promise<void>;
    private ensureLayout;
    private ensureFile;
    private requireSession;
    private record;
    private updateBrain;
    private appendTimeline;
    private writeSessionSummary;
    private readBrainFile;
    private applyStructuredMemory;
    private readMemoryRecords;
    private readMemoryGraph;
    private appendJsonl;
    private appendMarkdown;
    private appendList;
    private readJsonl;
}
/**
 * The id a record gets for a given (type, content) — content-derived and stable.
 * Exported so a supersede operation's `targetId` can be computed deterministically
 * (e.g. in tests) without first reading the record back.
 */
export declare function memoryRecordId(type: MemoryType, content: string): string;
