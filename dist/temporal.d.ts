import type { MemoryRecord } from "./types.js";
/**
 * The beliefs that were CURRENT as of `at`. A belief is current at `at` iff it had been created
 * by then (createdAt ≤ at) and had not yet been retired/replaced by then — i.e. it is still live,
 * or it was terminated (superseded/archived) only at a later time (updatedAt > at).
 */
export declare function currentAsOf(records: MemoryRecord[], at: string | number | Date): MemoryRecord[];
export type ChangeKind = "added" | "superseded" | "retired";
export interface ChangeEntry {
    kind: ChangeKind;
    at: string;
    record: MemoryRecord;
    replacementId?: string;
}
/**
 * The changelog over [from, to] (inclusive): beliefs added (created in window) and beliefs that
 * stopped being current in the window — `superseded` (has a successor) or `retired` (obsoleted,
 * no successor). Sorted chronologically. This is the "what changed" / knowledge-update view.
 */
export declare function changesBetween(records: MemoryRecord[], from: string | number | Date, to: string | number | Date): ChangeEntry[];
