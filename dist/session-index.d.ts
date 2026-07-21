/**
 * Durable sessionId → project mapping.
 *
 * The in-process tools layer needs to resolve which project a sessionId belongs
 * to. Holding that only in memory means a daemon restart mid-session orphans
 * every in-flight session ("Unknown Peon session"). This index persists the
 * mapping to disk so sessions survive restarts.
 *
 * Writes are serialized through a queue; each write rewrites the full JSON map
 * (fine for a local single-user tool). Ended sessions are removed to keep the
 * file small; a crash may leave a stale "active" entry, which `prune` clears.
 */
export interface SessionIndexRecord {
    sessionId: string;
    projectPath: string;
    client: string;
    cwd: string;
    startedAt: string;
}
export declare function defaultSessionIndexPath(): string;
export declare class SessionIndex {
    private readonly filePath;
    private cache?;
    private writeQueue;
    constructor(filePath?: string);
    get(sessionId: string): Promise<SessionIndexRecord | undefined>;
    set(record: SessionIndexRecord): Promise<void>;
    remove(sessionId: string): Promise<void>;
    active(): Promise<SessionIndexRecord[]>;
    /** Drop sessions older than maxAgeMs (stale entries from crashed runs). */
    prune(now: number, maxAgeMs: number): Promise<number>;
    private load;
    private persist;
}
