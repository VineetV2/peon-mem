import type { MemoryRecord, MemoryStatus } from "./types.js";
/**
 * Pure, in-memory transforms over a belief set. The store wraps these with
 * read + replaceMemoryRecords so the curation logic stays testable in isolation.
 */
export interface MemoryPatch {
    content?: string;
    importance?: number;
    confidence?: number;
    status?: MemoryStatus;
    pinned?: boolean;
}
/** Edit a belief's content/scores/status/pin. Unknown id → unchanged array. */
export declare function applyUpdate(records: readonly MemoryRecord[], id: string, patch: MemoryPatch, now: string): MemoryRecord[];
/** Remove a belief outright. */
export declare function applyDelete(records: readonly MemoryRecord[], id: string): MemoryRecord[];
/** Pin/unpin a belief — pinned beliefs are protected and rank first. */
export declare function applyPin(records: readonly MemoryRecord[], id: string, pinned: boolean, now: string): MemoryRecord[];
/**
 * Fold `dropId` into `keepId`: union the entities, take the higher importance and
 * confidence, OR the pin flag, then remove the dropped record. Either id missing
 * → unchanged array (no partial merge).
 */
export declare function applyMerge(records: readonly MemoryRecord[], keepId: string, dropId: string, now: string): MemoryRecord[];
