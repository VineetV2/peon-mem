import { diversifyByMMR, rankMemoryRecords } from "./retrieval.js";
const title = "Peon Context Injection v2";
const emptyPreview = `${title}\nNo memory selected.`;
export function buildContextInjection(options) {
    const maxChars = Math.max(0, Math.trunc(options.maxChars));
    const includeInactive = options.includeInactive === true;
    const projectResults = options.projectResults.map((item, originIndex) => ({ item, originIndex }));
    const globalResults = rankMemoryRecords(options.globalRecords, options.query, { now: options.now }).map((item, originIndex) => ({
        item,
        originIndex: projectResults.length + originIndex
    }));
    const omitted = [];
    const relevant = [...projectResults, ...globalResults]
        .filter((candidate) => {
        if (includeInactive || candidate.item.record.status === "active")
            return true;
        omitted.push(omittedMetadata(candidate.item, "suppressed_status"));
        return false;
    })
        .sort(compareCandidates);
    // Diversify (MMR) so the block has coverage, not N paraphrases of the top hit.
    // We reorder the relevance-sorted candidates by the diversified order of their records.
    const diversified = diversifyByMMR(relevant.map((c) => c.item));
    const orderOf = new Map(diversified.map((item, i) => [item, i]));
    const candidates = relevant.slice().sort((a, b) => (orderOf.get(a.item) ?? 0) - (orderOf.get(b.item) ?? 0));
    const selected = [];
    const lines = [title];
    let preview = lines.join("\n");
    for (const candidate of candidates) {
        const block = formatCandidate(candidate.item);
        const nextPreview = `${preview}\n${block}`;
        if (nextPreview.length > maxChars) {
            omitted.push(omittedMetadata(candidate.item, "max_chars"));
            continue;
        }
        preview = nextPreview;
        selected.push(selectedMetadata(candidate.item, block.length));
    }
    if (selected.length === 0 && emptyPreview.length <= maxChars) {
        preview = emptyPreview;
    }
    if (preview.length > maxChars) {
        preview = preview.slice(0, maxChars);
    }
    return {
        preview,
        selected,
        omitted,
        totalChars: preview.length,
        maxChars
    };
}
function compareCandidates(left, right) {
    const scoreDelta = injectionScore(right.item) - injectionScore(left.item);
    if (scoreDelta !== 0)
        return scoreDelta;
    const updatedDelta = timestamp(right.item.record.updatedAt) - timestamp(left.item.record.updatedAt);
    if (updatedDelta !== 0)
        return updatedDelta;
    return left.originIndex - right.originIndex;
}
function injectionScore(item) {
    if (item.record.status === "stale")
        return item.score - 4;
    if (item.record.status === "conflicted")
        return item.score - 1;
    return item.score;
}
function formatCandidate(item) {
    const record = item.record;
    const statusSuffix = record.status === "active" ? "" : ` status: ${record.status}`;
    return [
        `- [${record.scope}:${record.type}] ${redactSecrets(record.content)}${statusSuffix}`,
        `  why: ${redactSecrets(whySelected(item))}`
    ].join("\n");
}
function selectedMetadata(item, chars) {
    return {
        id: item.record.id,
        scope: item.record.scope,
        type: item.record.type,
        status: item.record.status,
        score: item.score,
        whySelected: redactSecrets(whySelected(item)),
        source: item.record.source,
        chars
    };
}
function omittedMetadata(item, reason) {
    return {
        id: item.record.id,
        scope: item.record.scope,
        type: item.record.type,
        status: item.record.status,
        reason,
        score: item.score
    };
}
function whySelected(item) {
    if (item.explanation.trim().length > 0)
        return item.explanation.trim();
    const positiveReasons = item.reasons.filter((reason) => reason.score > 0);
    if (positiveReasons.length > 0)
        return positiveReasons.map(formatReason).join("; ");
    return `score ${item.score.toFixed(3)}`;
}
function formatReason(reason) {
    return reason.label;
}
export function redactSecrets(value) {
    return value
        // Anthropic (must run before the generic sk- rule)
        .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "sk-ant-[REDACTED]")
        // OpenAI (sk-, sk-proj-, sk-live-, …)
        .replace(/\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]")
        // GitHub tokens
        .replace(/\b(gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]")
        // AWS access key id
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
        // Google API key
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza[REDACTED]")
        // JWTs (header.payload.signature)
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
        // Bearer tokens
        .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[REDACTED]")
        // Generic NAME=secret / NAME: secret for *_KEY/*_TOKEN/*_SECRET/PASSWORD/API_KEY (the \b before
        // the name is dropped so FOO_API_KEY=… with a leading underscore still matches)
        .replace(/((?:[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password))\s*[:=]\s*)[^\n]+/gi, "$1[REDACTED]");
}
function timestamp(value) {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
}
