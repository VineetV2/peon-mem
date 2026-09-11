export interface PeonLoggerOptions {
    logDir?: string;
    /** Rotate the live log once it exceeds this many bytes. */
    maxBytes?: number;
    /** Upper bound on how much of the log tail recent() will read. */
    tailBytes?: number;
}
export interface PeonLogEntry {
    id: string;
    type: string;
    createdAt: string;
    [key: string]: unknown;
}
export declare class PeonLogger {
    private readonly logFile;
    private readonly maxBytes;
    private readonly tailBytes;
    private writeQueue;
    private bytesWritten;
    private sizeKnown;
    constructor(options?: PeonLoggerOptions);
    log(type: string, fields?: Record<string, unknown>): Promise<PeonLogEntry>;
    /**
     * Newest-first entries from the tail of the log. Cost is bounded by
     * `tailBytes`, not by the size of the file, so this stays flat as the log
     * grows. Entries older than the tail window are not visible here — the log
     * file itself (and its rotated siblings) remain the full record.
     */
    recent(limit?: number): Promise<PeonLogEntry[]>;
    private readTail;
    /**
     * Move the live log aside once it exceeds maxBytes. History is preserved in a
     * timestamped sibling rather than truncated, so nothing is lost.
     */
    private rotateIfNeeded;
    private enqueueWrite;
}
