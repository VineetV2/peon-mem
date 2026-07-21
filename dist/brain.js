import { detectMemoryConflicts } from "./quality.js";
import { detectDuplicates } from "./overview.js";
import { applyMerge } from "./memory-mutations.js";
function isProtected(record, protectGlobalScope = true) {
    // Pinned beliefs are always protected. Global-scoped beliefs are protected when
    // curating a PROJECT brain (don't touch shared memory), but NOT when curating the
    // GLOBAL brain itself — there, global beliefs are the working set.
    if (record.pinned)
        return true;
    return protectGlobalScope && record.scope === "global";
}
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
/** Strength a belief starts at if it has never been scored — anchored to importance. */
function baseStrength(record) {
    return typeof record.strength === "number" ? record.strength : record.score.importance;
}
/**
 * Reinforcement: beliefs recalled since the last pass get stronger and a fresh
 * lastRecalledAt; everything else relaxes slightly toward its importance anchor.
 * This is the "use it or lose it" signal — except nothing is lost, it only
 * decides what stays detailed in working memory vs. eligible for compression.
 */
export function reinforce(records, recalledIds, now, protectGlobalScope = true) {
    const recalled = new Set(recalledIds);
    const actions = [];
    const out = records.map((record) => {
        const current = baseStrength(record);
        if (recalled.has(record.id)) {
            actions.push({ type: "reinforce", detail: `recalled: ${record.content.slice(0, 60)}`, affectedIds: [record.id] });
            return {
                ...record,
                strength: clamp01(current + 0.15 * (1 - current)),
                recallCount: (record.recallCount ?? 0) + 1,
                lastRecalledAt: now
            };
        }
        // Gentle relaxation toward the importance anchor (never below it for protected beliefs).
        const anchor = record.score.importance;
        const relaxed = isProtected(record, protectGlobalScope) ? Math.max(current, anchor) : current - 0.02 * (current - anchor * 0.5);
        return { ...record, strength: clamp01(relaxed) };
    });
    return { records: out, actions };
}
/**
 * Resolve detected conflicts autonomously: the higher-confidence belief wins,
 * ties break to the newer one; the loser is archived (recoverable), not deleted.
 */
export function resolveConflicts(records, now, protectGlobalScope = true) {
    // Consolidation flags BOTH sides of a conflict as "conflicted" and waits for a
    // human. The brain re-detects among active+conflicted and decides: winner back
    // to active, loser archived (recoverable).
    const candidates = records.filter((r) => r.status === "active" || r.status === "conflicted");
    const conflicts = detectMemoryConflicts(candidates);
    if (conflicts.length === 0)
        return { records: [...records], actions: [] };
    const byId = new Map(records.map((r) => [r.id, r]));
    const archived = new Set();
    const reactivated = new Set();
    const actions = [];
    for (const conflict of conflicts) {
        const left = byId.get(conflict.leftId);
        const right = byId.get(conflict.rightId);
        if (!left || !right)
            continue;
        if (archived.has(left.id) || archived.has(right.id))
            continue;
        // Protected beliefs always win; otherwise confidence, then recency.
        let loser;
        if (isProtected(left, protectGlobalScope) && !isProtected(right, protectGlobalScope))
            loser = right;
        else if (isProtected(right, protectGlobalScope) && !isProtected(left, protectGlobalScope))
            loser = left;
        else if (left.score.confidence !== right.score.confidence)
            loser = left.score.confidence < right.score.confidence ? left : right;
        else
            loser = left.updatedAt <= right.updatedAt ? left : right;
        const winner = loser.id === left.id ? right : left;
        if (isProtected(loser, protectGlobalScope))
            continue; // never archive a protected belief
        archived.add(loser.id);
        reactivated.add(winner.id);
        actions.push({
            type: "resolve_conflict",
            detail: `kept "${winner.content.slice(0, 40)}" over "${loser.content.slice(0, 40)}"`,
            affectedIds: [winner.id, loser.id]
        });
    }
    const out = records.map((r) => {
        if (archived.has(r.id))
            return { ...r, status: "archived", updatedAt: now };
        if (reactivated.has(r.id))
            return { ...r, status: "active", updatedAt: now };
        return r;
    });
    return { records: out, actions };
}
/**
 * Auto-merge near-duplicate beliefs: fold the weaker into the stronger (union
 * entities, keep the higher scores), archiving the raw copy via the merge helper's
 * delete — here we instead ARCHIVE the dropped record so nothing is lost.
 */
export function autoMergeDuplicates(records, now, threshold = 0.6, protectGlobalScope = true) {
    const pairs = detectDuplicates(records, { threshold, limit: 50 });
    if (pairs.length === 0)
        return { records: [...records], actions: [] };
    const byId = new Map(records.map((r) => [r.id, r]));
    let working = [...records];
    const archived = new Set();
    const actions = [];
    for (const pair of pairs) {
        const a = byId.get(pair.aId);
        const b = byId.get(pair.bId);
        if (!a || !b || archived.has(a.id) || archived.has(b.id))
            continue;
        if (isProtected(a, protectGlobalScope) && isProtected(b, protectGlobalScope))
            continue;
        // Keep the stronger (or protected) belief; archive the other.
        const keep = isProtected(a, protectGlobalScope) ? a : isProtected(b, protectGlobalScope) ? b : baseStrength(a) >= baseStrength(b) ? a : b;
        const drop = keep.id === a.id ? b : a;
        // Fold drop's entities/score into keep (applyMerge removes drop), then re-add
        // drop as an archived record so the raw copy is recoverable, not erased.
        working = applyMerge(working, keep.id, drop.id, now);
        working.push({ ...drop, status: "archived", summarizedBy: keep.id, updatedAt: now });
        archived.add(drop.id);
        actions.push({ type: "merge_duplicate", detail: `merged duplicate of "${keep.content.slice(0, 50)}"`, affectedIds: [keep.id, drop.id] });
    }
    return { records: working, actions };
}
/** Group ACTIVE, non-protected beliefs by their dominant entity. */
export function findTopicClusters(records, minSize, protectGlobalScope = true) {
    const byEntity = new Map();
    for (const record of records) {
        if (record.status !== "active" || isProtected(record, protectGlobalScope))
            continue;
        if (record.summaryOf)
            continue; // don't re-compress existing summaries
        const entity = (record.entities[0] ?? "").toLowerCase();
        if (!entity)
            continue;
        const list = byEntity.get(entity) ?? [];
        list.push(record);
        byEntity.set(entity, list);
    }
    return Array.from(byEntity.entries())
        .filter(([, members]) => members.length >= minSize)
        .map(([entity, members]) => ({ entity, members }));
}
/**
 * Compress topic clusters: when many beliefs share an entity, roll them into one
 * summary belief (via the injected LLM `summarize`) and archive the raw detail,
 * linked by summaryOf/summarizedBy. Working memory shrinks; nothing is lost.
 */
export async function compressTopicClusters(records, summarize, now, options = { makeId: (e) => `summary_${e}` }) {
    const minClusterSize = options.minClusterSize ?? 5;
    const maxClusters = options.maxClusters ?? 3; // bound LLM cost per pass
    const clusters = findTopicClusters(records, minClusterSize, options.protectGlobalScope ?? true)
        .sort((a, b) => b.members.length - a.members.length)
        .slice(0, maxClusters);
    if (clusters.length === 0)
        return { records: [...records], actions: [] };
    let working = [...records];
    const actions = [];
    for (const cluster of clusters) {
        const content = (await summarize(cluster)).trim();
        if (!content)
            continue;
        const memberIds = cluster.members.map((m) => m.id);
        const summaryId = options.makeId(cluster.entity);
        const importance = Math.max(...cluster.members.map((m) => m.score.importance));
        const entities = Array.from(new Set(cluster.members.flatMap((m) => m.entities)));
        const summary = {
            id: summaryId,
            type: "summary",
            content,
            normalized: content.toLowerCase(),
            scope: cluster.members[0].scope,
            status: "active",
            score: { importance, confidence: 0.82 },
            source: { kind: "ai_processing", reason: `compressed ${memberIds.length} beliefs about ${cluster.entity}` },
            entities,
            createdAt: now,
            updatedAt: now,
            strength: importance,
            summaryOf: memberIds
        };
        const memberSet = new Set(memberIds);
        working = working.map((r) => (memberSet.has(r.id) ? { ...r, status: "archived", summarizedBy: summaryId, updatedAt: now } : r));
        working.push(summary);
        actions.push({ type: "compress_cluster", detail: `compressed ${memberIds.length} beliefs about "${cluster.entity}" into one summary`, affectedIds: [summaryId, ...memberIds] });
    }
    return { records: working, actions };
}
/**
 * One full autonomous pass: reinforce → resolve conflicts → merge duplicates →
 * compress topic clusters. Returns the curated belief set and an action log.
 * The caller snapshots a backup BEFORE applying this — every step is recoverable.
 */
export async function runSleepCycle(records, options) {
    const actions = [];
    let working = [...records];
    const protectGlobalScope = options.protectGlobalScope ?? true;
    const r = reinforce(working, options.recalledIds ?? [], options.now, protectGlobalScope);
    working = r.records;
    actions.push(...r.actions);
    const c = resolveConflicts(working, options.now, protectGlobalScope);
    working = c.records;
    actions.push(...c.actions);
    const m = autoMergeDuplicates(working, options.now, 0.6, protectGlobalScope);
    working = m.records;
    actions.push(...m.actions);
    if (options.summarize) {
        const z = await compressTopicClusters(working, options.summarize, options.now, {
            minClusterSize: options.minClusterSize,
            maxClusters: options.maxClusters,
            protectGlobalScope,
            makeId: options.makeSummaryId
        });
        working = z.records;
        actions.push(...z.actions);
    }
    return { records: working, actions };
}
