export function deduplicateMemoryRecords(records) {
    const entries = [];
    const keyToIndex = new Map();
    const duplicates = [];
    for (const record of records) {
        const key = memoryKey(record);
        const existingIndex = keyToIndex.get(key);
        if (existingIndex === undefined) {
            keyToIndex.set(key, entries.length);
            entries.push({ key, record: cloneRecord(record) });
            continue;
        }
        const current = entries[existingIndex].record;
        const keepIncoming = memoryStrength(record) > memoryStrength(current);
        const kept = keepIncoming ? mergeDuplicate(record, current) : mergeDuplicate(current, record);
        entries[existingIndex] = { key, record: kept };
        duplicates.push({
            duplicateId: keepIncoming ? current.id : record.id,
            keptId: kept.id,
            key
        });
    }
    return {
        records: entries.map((entry) => entry.record),
        duplicates
    };
}
/**
 * An entity attached to more records than this is not evidence that two beliefs are
 * about the same thing — on a research brain "peon" or "BIRD" appears on thousands of
 * records, and pairing them all is what made this scan quadratic. Such buckets are
 * skipped; a conflict between two beliefs whose ONLY link is a ubiquitous tag is
 * exactly the false positive the same-topic gate already exists to suppress.
 */
const MAX_ENTITY_BUCKET = Number(process.env.PEON_CONFLICT_MAX_ENTITY_BUCKET) > 0
    ? Number(process.env.PEON_CONFLICT_MAX_ENTITY_BUCKET)
    : 2000;
const OPPOSING_WORD_PAIRS = [
    ["enabled", "disabled", "opposing enabled/disabled language"],
    ["enable", "disable", "opposing enable/disable language"],
    ["allowed", "forbidden", "opposing allowed/forbidden language"],
    ["allow", "deny", "opposing allow/deny language"],
    ["required", "optional", "opposing required/optional language"],
    ["true", "false", "opposing true/false language"],
    ["yes", "no", "opposing yes/no language"],
    ["use", "avoid", "opposing use/avoid language"]
];
let lastPairsEvaluated = 0;
/** How many record pairs the last scan actually string-compared. */
export function conflictScanStats() {
    return { pairsEvaluated: lastPairsEvaluated };
}
function prepareForConflicts(records) {
    return records.map((record) => {
        const entityPairs = record.entities.map((entity) => [normalizeEntity(entity), entity]);
        const entityByNormalized = new Map();
        // Later duplicates lose, matching the original Map-from-entries behaviour.
        for (const [normalized, original] of entityPairs)
            entityByNormalized.set(normalized, original);
        const text = normalizeMemory(record.content);
        return {
            record,
            entityPairs,
            entityByNormalized,
            normalizedEntities: new Set(entityPairs.map(([normalized]) => normalized)),
            words: new Set(text.split(" ").filter(Boolean)),
            topicTokens: contentTokens(record.content)
        };
    });
}
function sharedEntityOf(left, right) {
    for (const [normalized, original] of left.entityPairs) {
        const match = right.entityByNormalized.get(normalized);
        if (match)
            return original.trim() || match;
    }
    return undefined;
}
/**
 * Word presence via the precomputed token set. normalizeMemory() strips punctuation
 * and collapses whitespace, so the old `(^|\s)word($|\s)` regex was exactly a test
 * for "word is a whitespace-delimited token" — a Set lookup is equivalent, without
 * building a RegExp per check.
 */
function opposingReasonOf(left, right) {
    for (const [positive, negative, reason] of OPPOSING_WORD_PAIRS) {
        if (left.words.has(positive) && right.words.has(negative))
            return reason;
        if (left.words.has(negative) && right.words.has(positive))
            return reason;
    }
    return undefined;
}
function sameTopicOf(left, right) {
    let sharedEntities = 0;
    for (const entity of left.normalizedEntities)
        if (right.normalizedEntities.has(entity))
            sharedEntities += 1;
    if (sharedEntities >= 2)
        return true;
    if (left.topicTokens.size === 0 || right.topicTokens.size === 0)
        return false;
    let intersection = 0;
    for (const token of left.topicTokens)
        if (right.topicTokens.has(token))
            intersection += 1;
    const jaccard = intersection / (left.topicTokens.size + right.topicTokens.size - intersection);
    return jaccard >= 0.25;
}
/**
 * Conflicts require a shared entity, so only pairs that co-occur in some entity's
 * bucket can ever qualify. Indexing by entity skips the overwhelming majority of
 * pairs without touching a string; everything derived per record (normalized text,
 * token sets, entity maps) is computed once instead of once per pair.
 */
export function detectMemoryConflicts(records, options = {}) {
    const prepared = prepareForConflicts(records);
    const found = [];
    let pairsEvaluated = 0;
    const evaluate = (leftIndex, rightIndex) => {
        pairsEvaluated += 1;
        const left = prepared[leftIndex];
        const right = prepared[rightIndex];
        const entity = sharedEntityOf(left, right);
        if (!entity)
            return;
        const reason = opposingReasonOf(left, right);
        if (!reason)
            return;
        // Same-topic gate. A shared entity + one opposing word-pair somewhere in two long beliefs
        // is a weak signal: on a research brain, dozens of beliefs all mention "BIRD" and one says
        // "use X" while an unrelated one says "avoid Y". They don't contradict — they're just both
        // about BIRD. Require the two beliefs to actually be discussing the same thing before
        // calling it a conflict: several shared entities, or real content overlap beyond the token.
        if (!sameTopicOf(left, right))
            return;
        found.push({
            leftIndex,
            rightIndex,
            conflict: { entity, leftId: left.record.id, rightId: right.record.id, reason }
        });
    };
    if (options.exhaustive) {
        for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
                evaluate(leftIndex, rightIndex);
            }
        }
    }
    else {
        const byEntity = new Map();
        for (let index = 0; index < prepared.length; index += 1) {
            for (const entity of prepared[index].normalizedEntities) {
                const bucket = byEntity.get(entity);
                if (bucket)
                    bucket.push(index);
                else
                    byEntity.set(entity, [index]);
            }
        }
        const seen = new Set();
        const width = prepared.length;
        for (const bucket of byEntity.values()) {
            if (bucket.length > (options.maxEntityBucket ?? MAX_ENTITY_BUCKET))
                continue;
            for (let a = 0; a < bucket.length; a += 1) {
                for (let b = a + 1; b < bucket.length; b += 1) {
                    const leftIndex = bucket[a];
                    const rightIndex = bucket[b];
                    const key = leftIndex * width + rightIndex;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    evaluate(leftIndex, rightIndex);
                }
            }
        }
        // Restore the original left-to-right emission order.
        found.sort((x, y) => x.leftIndex - y.leftIndex || x.rightIndex - y.rightIndex);
    }
    lastPairsEvaluated = pairsEvaluated;
    return found.map((entry) => entry.conflict);
}
export function markStaleMemoryRecords(records, options = {}) {
    const now = options.now ?? new Date();
    const staleAfterDays = options.staleAfterDays ?? 120;
    const staleIds = [];
    return {
        records: records.map((record) => {
            if (record.status !== "active")
                return cloneRecord(record);
            if (ageInDays(record.updatedAt, now) <= staleAfterDays)
                return cloneRecord(record);
            staleIds.push(record.id);
            return {
                ...cloneRecord(record),
                status: "stale"
            };
        }),
        staleIds
    };
}
export function promoteMemoryRecords(records, options = {}) {
    const repeatThreshold = options.repeatThreshold ?? 2;
    const repeatBoost = options.repeatBoost ?? 0.2;
    const importantBoost = options.importantBoost ?? 0.15;
    const repeatedCounts = countNormalized(options.repeatedContent ?? []);
    const importantTerms = (options.importantTerms ?? []).map(normalizeMemory).filter(Boolean);
    const promoted = [];
    const promotedRecords = records.map((record) => {
        const normalized = normalizeMemory(record.content);
        const isRepeated = (repeatedCounts.get(normalized) ?? 0) >= repeatThreshold;
        const isImportant = importantTerms.some((term) => normalized.includes(term));
        const boost = (isRepeated ? repeatBoost : 0) + (isImportant ? importantBoost : 0);
        if (boost <= 0)
            return cloneRecord(record);
        const importance = clamp(record.score.importance + boost);
        if (importance === record.score.importance)
            return cloneRecord(record);
        promoted.push({
            id: record.id,
            reason: isRepeated ? "repeated" : "important",
            importance
        });
        return {
            ...cloneRecord(record),
            score: {
                ...record.score,
                importance
            }
        };
    });
    return { records: promotedRecords, promoted };
}
export function applyMemoryQualityReport(records, report) {
    return {
        records: report.records.map(cloneRecord),
        audit: summarizeMemoryQualityReport(report, records)
    };
}
export function summarizeMemoryQualityReport(report, records) {
    const removedIds = uniquePreservingOrder(report.duplicates.map((duplicate) => duplicate.duplicateId));
    const updatedIds = [];
    const retainedIds = [];
    if (records) {
        const finalById = new Map(report.records.map((record) => [record.id, record]));
        for (const record of records) {
            const finalRecord = finalById.get(record.id);
            if (!finalRecord) {
                if (!removedIds.includes(record.id))
                    removedIds.push(record.id);
                continue;
            }
            if (sameJsonSafeRecord(record, finalRecord)) {
                retainedIds.push(record.id);
            }
            else {
                updatedIds.push(record.id);
            }
        }
    }
    else {
        const changedIds = new Set();
        for (const id of report.staleIds)
            changedIds.add(id);
        for (const id of report.promotedIds)
            changedIds.add(id);
        for (const conflict of report.conflicts) {
            changedIds.add(conflict.leftId);
            changedIds.add(conflict.rightId);
        }
        for (const record of report.records) {
            if (changedIds.has(record.id)) {
                updatedIds.push(record.id);
            }
            else {
                retainedIds.push(record.id);
            }
        }
    }
    return {
        inputCount: report.inputCount,
        outputCount: report.outputCount,
        removedDuplicateCount: report.duplicates.length,
        conflictCount: report.conflicts.length,
        staleCount: report.staleIds.length,
        promotedCount: report.promotedIds.length,
        changedCount: updatedIds.length,
        unchangedCount: retainedIds.length,
        removedIds,
        updatedIds,
        retainedIds
    };
}
export function serializeMemoryQualityReport(report) {
    return {
        inputCount: safeInteger(report.inputCount),
        outputCount: safeInteger(report.outputCount),
        records: report.records.map(jsonSafeRecord),
        duplicates: report.duplicates.map((duplicate) => ({
            duplicateId: String(duplicate.duplicateId),
            keptId: String(duplicate.keptId),
            key: String(duplicate.key)
        })),
        conflicts: report.conflicts.map((conflict) => ({
            entity: String(conflict.entity),
            leftId: String(conflict.leftId),
            rightId: String(conflict.rightId),
            reason: String(conflict.reason)
        })),
        staleIds: report.staleIds.map(String),
        promotedIds: report.promotedIds.map(String),
        audit: summarizeMemoryQualityReport(report)
    };
}
export function createQualityReport(records, options = {}) {
    const deduplicated = deduplicateMemoryRecords(records);
    const stale = markStaleMemoryRecords(deduplicated.records, options);
    const promoted = promoteMemoryRecords(stale.records, options);
    // Superseded records are a settled verdict (a belief was explicitly replaced);
    // never re-flag them as "conflicted" — that would clobber the supersede link.
    const conflicts = detectMemoryConflicts(promoted.records.filter((record) => record.status !== "superseded"));
    const conflictedIds = new Set(conflicts.flatMap((conflict) => [conflict.leftId, conflict.rightId]));
    const finalRecords = promoted.records.map((record) => conflictedIds.has(record.id)
        ? {
            ...cloneRecord(record),
            status: "conflicted"
        }
        : cloneRecord(record));
    return {
        inputCount: records.length,
        outputCount: finalRecords.length,
        records: finalRecords,
        duplicates: deduplicated.duplicates,
        conflicts,
        staleIds: stale.staleIds,
        promotedIds: promoted.promoted.map((record) => record.id)
    };
}
function memoryKey(record) {
    return `${record.type}:${normalizeMemory(record.content)}`;
}
function mergeDuplicate(kept, duplicate) {
    return {
        ...cloneRecord(kept),
        score: {
            importance: clamp(Math.max(kept.score.importance, duplicate.score.importance)),
            confidence: clamp(Math.max(kept.score.confidence, duplicate.score.confidence))
        },
        entities: uniqueSorted([...kept.entities, ...duplicate.entities])
    };
}
function memoryStrength(record) {
    return record.score.importance + record.score.confidence + epochMillis(record.updatedAt) / 1_000_000_000_000_000;
}
function sharedEntity(left, right) {
    const rightEntities = new Map(right.entities.map((entity) => [normalizeEntity(entity), entity]));
    for (const leftEntity of left.entities) {
        const match = rightEntities.get(normalizeEntity(leftEntity));
        if (match)
            return leftEntity.trim() || match;
    }
    return undefined;
}
const TOPIC_STOP = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are", "was",
    "were", "be", "as", "at", "by", "it", "this", "that", "we", "our", "use", "used", "using", "from",
    "not", "no", "yes", "do", "does", "did", "so", "if", "then", "than", "when", "which", "what"
]);
/** Content tokens (lowercased, ≥3 chars, minus stopwords) — the topical fingerprint of a belief. */
function contentTokens(text) {
    const out = new Set();
    for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length >= 3 && !TOPIC_STOP.has(raw))
            out.add(raw);
    }
    return out;
}
/**
 * True when two beliefs are actually discussing the same thing — the precondition for their
 * opposing language to be a real contradiction rather than a coincidence. Satisfied by either
 * multiple shared entities (a strong same-subject signal) or meaningful content overlap
 * (Jaccard of content tokens above a floor). Prevents "both mention BIRD, one says use / one
 * says avoid, about unrelated things" from being flagged.
 */
function sameTopic(left, right) {
    const le = new Set(left.entities.map(normalizeEntity));
    const re = new Set(right.entities.map(normalizeEntity));
    let sharedEntities = 0;
    for (const e of le)
        if (re.has(e))
            sharedEntities += 1;
    if (sharedEntities >= 2)
        return true;
    const lt = contentTokens(left.content);
    const rt = contentTokens(right.content);
    if (lt.size === 0 || rt.size === 0)
        return false;
    let inter = 0;
    for (const t of lt)
        if (rt.has(t))
            inter += 1;
    const jaccard = inter / (lt.size + rt.size - inter);
    return jaccard >= 0.25;
}
function opposingLanguageReason(left, right) {
    const leftText = normalizeMemory(left);
    const rightText = normalizeMemory(right);
    const pairs = [
        ["enabled", "disabled", "opposing enabled/disabled language"],
        ["enable", "disable", "opposing enable/disable language"],
        ["allowed", "forbidden", "opposing allowed/forbidden language"],
        ["allow", "deny", "opposing allow/deny language"],
        ["required", "optional", "opposing required/optional language"],
        ["true", "false", "opposing true/false language"],
        ["yes", "no", "opposing yes/no language"],
        ["use", "avoid", "opposing use/avoid language"]
    ];
    for (const [positive, negative, reason] of pairs) {
        if (hasWord(leftText, positive) && hasWord(rightText, negative))
            return reason;
        if (hasWord(leftText, negative) && hasWord(rightText, positive))
            return reason;
    }
    return undefined;
}
function ageInDays(value, now) {
    const updatedAt = epochMillis(value);
    if (!Number.isFinite(updatedAt))
        return 0;
    return (now.getTime() - updatedAt) / 86_400_000;
}
function epochMillis(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}
function countNormalized(values) {
    const counts = new Map();
    for (const value of values) {
        const normalized = normalizeMemory(value);
        if (!normalized)
            continue;
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
    return counts;
}
function normalizeMemory(content) {
    return content
        .toLowerCase()
        .replace(/[`"'.,;:!?()[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function normalizeEntity(entity) {
    return normalizeMemory(entity);
}
function hasWord(content, word) {
    return new RegExp(`(^|\\s)${escapeRegExp(word)}($|\\s)`).test(content);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function uniqueSorted(values) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) => left.localeCompare(right));
}
function uniquePreservingOrder(values) {
    const seen = new Set();
    return values.filter((value) => {
        if (seen.has(value))
            return false;
        seen.add(value);
        return true;
    });
}
function cloneRecord(record) {
    return {
        ...record,
        score: { ...record.score },
        source: { ...record.source },
        entities: [...record.entities]
    };
}
function clamp(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
function safeInteger(value) {
    return Number.isSafeInteger(value) ? value : 0;
}
function sameJsonSafeRecord(left, right) {
    return JSON.stringify(jsonSafeRecord(left)) === JSON.stringify(jsonSafeRecord(right));
}
function jsonSafeRecord(record) {
    return {
        id: String(record.id),
        type: record.type,
        content: String(record.content),
        normalized: String(record.normalized),
        scope: record.scope,
        status: record.status,
        score: {
            importance: clamp(record.score.importance),
            confidence: clamp(record.score.confidence)
        },
        source: {
            kind: record.source.kind,
            ...(record.source.reason === undefined ? {} : { reason: String(record.source.reason) })
        },
        entities: record.entities.map(String),
        createdAt: String(record.createdAt),
        updatedAt: String(record.updatedAt),
        ...(record.supersededBy === undefined ? {} : { supersededBy: String(record.supersededBy) })
    };
}
