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

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function touch(record: MemoryRecord, now: string): MemoryRecord {
  return { ...record, updatedAt: now };
}

/** Edit a belief's content/scores/status/pin. Unknown id → unchanged array. */
export function applyUpdate(
  records: readonly MemoryRecord[],
  id: string,
  patch: MemoryPatch,
  now: string
): MemoryRecord[] {
  return records.map((record) => {
    if (record.id !== id) return record;
    const next: MemoryRecord = touch(record, now);
    if (typeof patch.content === "string" && patch.content.trim()) next.content = patch.content.trim();
    if (typeof patch.importance === "number") next.score = { ...next.score, importance: clamp(patch.importance) };
    if (typeof patch.confidence === "number") next.score = { ...next.score, confidence: clamp(patch.confidence) };
    if (patch.status) next.status = patch.status;
    if (typeof patch.pinned === "boolean") next.pinned = patch.pinned;
    return next;
  });
}

/** Remove a belief outright. */
export function applyDelete(records: readonly MemoryRecord[], id: string): MemoryRecord[] {
  return records.filter((record) => record.id !== id);
}

/** Pin/unpin a belief — pinned beliefs are protected and rank first. */
export function applyPin(records: readonly MemoryRecord[], id: string, pinned: boolean, now: string): MemoryRecord[] {
  return applyUpdate(records, id, { pinned }, now);
}

/**
 * Fold `dropId` into `keepId`: union the entities, take the higher importance and
 * confidence, OR the pin flag, then remove the dropped record. Either id missing
 * → unchanged array (no partial merge).
 */
export function applyMerge(
  records: readonly MemoryRecord[],
  keepId: string,
  dropId: string,
  now: string
): MemoryRecord[] {
  if (keepId === dropId) return [...records];
  const keep = records.find((r) => r.id === keepId);
  const drop = records.find((r) => r.id === dropId);
  if (!keep || !drop) return [...records];
  const merged: MemoryRecord = {
    ...keep,
    updatedAt: now,
    pinned: Boolean(keep.pinned || drop.pinned),
    score: {
      importance: Math.max(keep.score.importance, drop.score.importance),
      confidence: Math.max(keep.score.confidence, drop.score.confidence)
    },
    entities: Array.from(new Set([...keep.entities, ...drop.entities]))
  };
  return records.filter((r) => r.id !== dropId).map((r) => (r.id === keepId ? merged : r));
}
