import type { MemoryRecord, MemoryRecordInput, MemoryStatus, MemoryType } from "./types.js";
export interface OpenGlobalMemoryStoreOptions {
    globalDir?: string;
}
export interface ListGlobalMemoryOptions {
    query?: string;
    type?: MemoryType;
    status?: MemoryStatus;
}
export interface GlobalMemorySource {
    kind?: MemoryRecord["source"]["kind"];
    reason?: string;
}
export declare class PeonGlobalMemoryStore {
    private readonly globalDir;
    private static readonly defaultGlobalDir;
    private constructor();
    static defaultDirectory(): string;
    static open(options?: OpenGlobalMemoryStoreOptions): Promise<PeonGlobalMemoryStore>;
    append(input: MemoryRecordInput, source?: GlobalMemorySource): Promise<MemoryRecord>;
    upsert(input: MemoryRecordInput, source?: GlobalMemorySource): Promise<MemoryRecord>;
    list(options?: ListGlobalMemoryOptions): Promise<MemoryRecord[]>;
    search(query: string, options?: Omit<ListGlobalMemoryOptions, "query">): Promise<MemoryRecord[]>;
    /**
     * Curate the GLOBAL brain itself: resolve conflicts and merge duplicates across
     * the shared cross-project memory (global beliefs are the working set here, so
     * they are NOT treated as protected). Snapshots a backup first. LLM compression
     * is opt-in via the summarizer. Returns the actions taken.
     */
    runBrainPass(options?: {
        summarize?: import("./brain.js").Summarizer;
    }): Promise<import("./brain.js").BrainAction[]>;
    readBrainActions(limit?: number): Promise<Array<{
        at: string;
        actions: import("./brain.js").BrainAction[];
    }>>;
    private snapshotBackup;
    importGlobalRecords(records: MemoryRecord[], source?: GlobalMemorySource): Promise<MemoryRecord[]>;
    private ensureLayout;
    private recordsPath;
    private readRecords;
    private writeRecords;
}
