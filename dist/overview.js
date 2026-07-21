export function summarizeBeliefs(records) {
    const counts = { active: 0, superseded: 0, conflicts: 0, stale: 0, archived: 0, summaries: 0, pinned: 0, total: records.length };
    for (const record of records) {
        if (record.status === "active")
            counts.active += 1;
        else if (record.status === "superseded")
            counts.superseded += 1;
        else if (record.status === "conflicted")
            counts.conflicts += 1;
        else if (record.status === "stale")
            counts.stale += 1;
        else if (record.status === "archived")
            counts.archived += 1;
        if (record.summaryOf)
            counts.summaries += 1;
        if (record.pinned)
            counts.pinned += 1;
    }
    return counts;
}
/**
 * Drop accidental subdirectory brains: a project nested inside another known
 * project that holds NO active beliefs is an empty `.peon` from a session that
 * ran with a subdir as cwd. Real (non-empty) nested projects are kept — we never
 * merge memory, only hide empty noise.
 */
export function filterStrayProjects(projects) {
    const paths = projects.map((p) => p.projectPath);
    return projects.filter((p) => {
        const nested = paths.some((other) => other !== p.projectPath && p.projectPath.startsWith(other + "/"));
        return !(nested && p.active === 0);
    });
}
function wordSet(text) {
    return new Set(text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3));
}
function jaccard(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let shared = 0;
    for (const word of a)
        if (b.has(word))
            shared += 1;
    return shared / (a.size + b.size - shared);
}
/**
 * Flag near-duplicate ACTIVE beliefs of the same type — a nudge for the user to
 * merge, not an automatic action. Conservative threshold to avoid false alarms.
 */
export function detectDuplicates(records, options = {}) {
    const threshold = options.threshold ?? 0.6;
    const limit = options.limit ?? 5;
    const active = records.filter((record) => record.status === "active");
    const sets = active.map((record) => wordSet(record.content));
    const pairs = [];
    for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
            if (active[i].type !== active[j].type)
                continue;
            const similarity = jaccard(sets[i], sets[j]);
            if (similarity >= threshold) {
                pairs.push({
                    aId: active[i].id,
                    aContent: active[i].content,
                    bId: active[j].id,
                    bContent: active[j].content,
                    similarity: Math.round(similarity * 100) / 100
                });
            }
        }
    }
    return pairs.sort((left, right) => right.similarity - left.similarity).slice(0, limit);
}
/**
 * Compare Peon-on vs Peon-off session token totals for a project. Returns null
 * until BOTH arms have at least one session — a savings claim needs a baseline.
 */
export function computeTokenSavings(records, projectPath) {
    const forProject = records.filter((record) => record.projectPath === projectPath);
    const on = forProject.filter((record) => record.peonEnabled === true).map((record) => record.totalTokens ?? 0);
    const off = forProject.filter((record) => record.peonEnabled === false).map((record) => record.totalTokens ?? 0);
    if (on.length === 0 || off.length === 0)
        return null;
    const avg = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
    const onAvg = avg(on);
    const offAvg = avg(off);
    return { onAvg, offAvg, onSessions: on.length, offSessions: off.length, savedPerSession: offAvg - onAvg };
}
/**
 * Turn the injection's selected-id metadata into displayable items by joining
 * back to the records' content (project + global). Ids with no match are dropped.
 */
export function enrichInjection(selected, records) {
    const byId = new Map(records.map((record) => [record.id, record]));
    return selected.flatMap((item) => {
        const record = byId.get(item.id);
        if (!record)
            return [];
        return [{ id: item.id, scope: item.scope, type: item.type, content: record.content, score: Math.round(item.score * 100) / 100 }];
    });
}
