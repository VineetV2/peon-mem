function clamp(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
function touch(record, now) {
    return { ...record, updatedAt: now };
}
/** Edit a belief's content/scores/status/pin. Unknown id → unchanged array. */
export function applyUpdate(records, id, patch, now) {
    return records.map((record) => {
        if (record.id !== id)
            return record;
        const next = touch(record, now);
        if (typeof patch.content === "string" && patch.content.trim())
            next.content = patch.content.trim();
        if (typeof patch.importance === "number")
            next.score = { ...next.score, importance: clamp(patch.importance) };
        if (typeof patch.confidence === "number")
            next.score = { ...next.score, confidence: clamp(patch.confidence) };
        if (patch.status)
            next.status = patch.status;
        if (typeof patch.pinned === "boolean")
            next.pinned = patch.pinned;
        return next;
    });
}
/** Remove a belief outright. */
export function applyDelete(records, id) {
    return records.filter((record) => record.id !== id);
}
/** Pin/unpin a belief — pinned beliefs are protected and rank first. */
export function applyPin(records, id, pinned, now) {
    return applyUpdate(records, id, { pinned }, now);
}
/**
 * Fold `dropId` into `keepId`: union the entities, take the higher importance and
 * confidence, OR the pin flag, then remove the dropped record. Either id missing
 * → unchanged array (no partial merge).
 */
export function applyMerge(records, keepId, dropId, now) {
    if (keepId === dropId)
        return [...records];
    const keep = records.find((r) => r.id === keepId);
    const drop = records.find((r) => r.id === dropId);
    if (!keep || !drop)
        return [...records];
    const merged = {
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
