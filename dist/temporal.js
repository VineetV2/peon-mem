/**
 * Temporal retrieval over the belief store. Peon already keeps the history of a belief: when a
 * fact changes, the old record is flipped to `superseded` (its `updatedAt` is the moment it
 * stopped being true) and linked to its successor via `supersededBy`; an obsoleted belief is
 * superseded with no successor. That history lets us answer two questions a flat "current state"
 * store cannot:
 *
 *   • as-of  — "what did we believe at time T?"  (currentAsOf)
 *   • diff   — "what changed between T1 and T2?" (changesBetween)
 *
 * Both are pure, deterministic, and timestamp-only — no LLM. They turn the supersession chain
 * the consolidator already maintains into first-class time-travel queries.
 */
/** Statuses that mark a belief as no longer current; their `updatedAt` is when it stopped being current. */
const TERMINAL_STATUSES = new Set(["superseded", "archived"]);
function ms(value) {
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}
/**
 * The beliefs that were CURRENT as of `at`. A belief is current at `at` iff it had been created
 * by then (createdAt ≤ at) and had not yet been retired/replaced by then — i.e. it is still live,
 * or it was terminated (superseded/archived) only at a later time (updatedAt > at).
 */
export function currentAsOf(records, at) {
    const t = ms(at);
    return records.filter((r) => {
        if (ms(r.createdAt) > t)
            return false; // didn't exist yet
        if (TERMINAL_STATUSES.has(r.status))
            return ms(r.updatedAt) > t; // retired only after `at`
        return true; // active / stale / conflicted — live at `at`
    });
}
/**
 * The changelog over [from, to] (inclusive): beliefs added (created in window) and beliefs that
 * stopped being current in the window — `superseded` (has a successor) or `retired` (obsoleted,
 * no successor). Sorted chronologically. This is the "what changed" / knowledge-update view.
 */
export function changesBetween(records, from, to) {
    const lo = ms(from);
    const hi = ms(to);
    const entries = [];
    for (const r of records) {
        const created = ms(r.createdAt);
        if (created >= lo && created <= hi) {
            entries.push({ kind: "added", at: r.createdAt, record: r });
        }
        if (r.status === "superseded") {
            const changedAt = ms(r.updatedAt);
            if (changedAt >= lo && changedAt <= hi) {
                entries.push({
                    kind: r.supersededBy ? "superseded" : "retired",
                    at: r.updatedAt,
                    record: r,
                    replacementId: r.supersededBy
                });
            }
        }
    }
    return entries.sort((a, b) => ms(a.at) - ms(b.at));
}
