export interface PeonLoggerOptions {
    logDir?: string;
}
export interface PeonLogEntry {
    id: string;
    type: string;
    createdAt: string;
    [key: string]: unknown;
}
export declare class PeonLogger {
    private readonly logFile;
    private writeQueue;
    constructor(options?: PeonLoggerOptions);
    log(type: string, fields?: Record<string, unknown>): Promise<PeonLogEntry>;
    recent(limit?: number): Promise<PeonLogEntry[]>;
    private enqueueWrite;
}
