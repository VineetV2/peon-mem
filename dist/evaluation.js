import { readFile } from "node:fs/promises";
import { join } from "node:path";
export function computeEvaluationReport(input) {
    const expected = normalizeExpected(input.expectedMemories);
    const observed = [
        ...extractObservedItems(input.retrievedText, "retrieved"),
        ...extractObservedItems(input.injectedText, "injected")
    ];
    const matches = matchExpectedToObserved(expected, observed);
    const matchedExpectedIds = new Set(matches.map((match) => match.expectedId));
    const matchedObservedKeys = new Set(matches.map((match) => observedKey(match.observedSource, match.observedContent)));
    return {
        expectedCount: expected.length,
        observedItemCount: observed.length,
        matchedExpectedCount: matchedExpectedIds.size,
        matchedObservedItemCount: matchedObservedKeys.size,
        recall: ratio(matchedExpectedIds.size, expected.length),
        coverage: ratio(matchedObservedKeys.size, observed.length),
        missingExpectedItems: expected
            .filter((item) => !matchedExpectedIds.has(item.id))
            .map((item) => ({ id: item.id, content: item.content })),
        unexpectedNoisyItems: observed
            .filter((item) => !matchedObservedKeys.has(observedKey(item.source, item.content)))
            .map((item) => ({ source: item.source, content: item.content })),
        matches,
        costSummary: summarizeCost(input.processingJobs ?? [])
    };
}
export async function evaluatePeonProject(input) {
    const peonPath = join(input.projectPath, input.memoryDirName ?? ".peon");
    const expectedMemories = input.expectedMemories ?? (await readExpectedMemories(peonPath));
    const retrievedText = await readRetrievedProjectText(peonPath);
    const injectedText = await readOptionalText(join(peonPath, "brain", "injection-preview.md"));
    const processingJobs = await readProcessingJobs(peonPath);
    return computeEvaluationReport({
        expectedMemories,
        retrievedText,
        injectedText,
        processingJobs
    });
}
function normalizeExpected(items) {
    return items
        .map((item, index) => {
        const content = typeof item === "string" ? item : item.content;
        const id = typeof item === "string" ? `expected-${index + 1}` : item.id ?? `expected-${index + 1}`;
        return {
            id,
            content: content.trim(),
            tokens: tokenize(content),
            normalized: normalizeText(content)
        };
    })
        .filter((item) => item.content.length > 0);
}
function extractObservedItems(input, source) {
    const chunks = Array.isArray(input) ? input : input ? [input] : [];
    return chunks.flatMap((chunk) => chunk
        .split(/\r?\n/)
        .map(cleanObservedLine)
        .filter(isMeaningfulObservedLine)
        .map((content) => ({
        source,
        content,
        tokens: tokenize(content),
        normalized: normalizeText(content)
    })));
}
function cleanObservedLine(line) {
    return line
        .trim()
        .replace(/^[-*]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim();
}
function isMeaningfulObservedLine(line) {
    if (!line)
        return false;
    if (/^#+\s*/.test(line))
        return false;
    if (/^[A-Z][A-Za-z ]{1,32}:?$/.test(line))
        return false;
    return tokenize(line).length > 0;
}
function matchExpectedToObserved(expected, observed) {
    return expected.flatMap((item) => {
        const best = observed
            .map((candidate) => ({ candidate, score: matchScore(item, candidate) }))
            .filter((candidate) => candidate.score >= 0.6)
            .sort((left, right) => right.score - left.score || sourceRank(left.candidate.source) - sourceRank(right.candidate.source) || left.candidate.content.localeCompare(right.candidate.content))[0];
        return best
            ? [
                {
                    expectedId: item.id,
                    expectedContent: item.content,
                    observedSource: best.candidate.source,
                    observedContent: best.candidate.content,
                    score: round4(best.score)
                }
            ]
            : [];
    });
}
function matchScore(expected, observed) {
    if (!expected.tokens.length || !observed.tokens.length)
        return 0;
    if (observed.normalized.includes(expected.normalized) || expected.normalized.includes(observed.normalized))
        return 1;
    const observedTokens = new Set(observed.tokens);
    const hits = expected.tokens.filter((token) => observedTokens.has(token)).length;
    return hits / expected.tokens.length;
}
function summarizeCost(jobs) {
    const summary = {
        jobCount: jobs.length,
        processedJobs: 0,
        skippedJobs: 0,
        failedJobs: 0,
        totalEstimatedTokens: 0,
        byModel: {}
    };
    for (const job of jobs) {
        const status = job.status ?? "unknown";
        const tokens = Number.isFinite(job.estimatedTokens) ? Math.max(0, Math.trunc(job.estimatedTokens ?? 0)) : 0;
        const model = job.model || "unknown";
        if (status === "processed")
            summary.processedJobs += 1;
        if (status === "skipped")
            summary.skippedJobs += 1;
        if (status === "failed")
            summary.failedJobs += 1;
        summary.totalEstimatedTokens += tokens;
        summary.byModel[model] ??= { jobCount: 0, estimatedTokens: 0 };
        summary.byModel[model].jobCount += 1;
        summary.byModel[model].estimatedTokens += tokens;
    }
    return summary;
}
async function readExpectedMemories(peonPath) {
    const candidates = [
        join(peonPath, "evaluation", "expected-memories.json"),
        join(peonPath, "expected-memories.json")
    ];
    for (const candidate of candidates) {
        const text = await readOptionalText(candidate);
        if (!text.trim())
            continue;
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            throw new Error(`${candidate} must contain a JSON array.`);
        return parsed.flatMap((item) => {
            if (typeof item === "string")
                return [item];
            if (isObject(item) && typeof item.content === "string") {
                return [{ id: typeof item.id === "string" ? item.id : undefined, content: item.content }];
            }
            return [];
        });
    }
    return [];
}
async function readRetrievedProjectText(peonPath) {
    const brainPath = join(peonPath, "brain");
    const markdownFiles = [
        "project-summary.md",
        "decisions.md",
        "preferences.md",
        "open-questions.md",
        "artifacts.md",
        "timeline.md"
    ];
    const markdown = await Promise.all(markdownFiles.map((file) => readOptionalText(join(brainPath, file))));
    const records = await readMemoryRecordContents(join(brainPath, "memories.jsonl"));
    return [...markdown, records.join("\n")].filter((text) => text.trim().length > 0);
}
async function readMemoryRecordContents(path) {
    const text = await readOptionalText(path);
    return text
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
        const parsed = JSON.parse(line);
        return isObject(parsed) && typeof parsed.content === "string" ? [parsed.content] : [];
    });
}
async function readProcessingJobs(peonPath) {
    const jobsPath = join(peonPath, "brain", "processing-jobs.json");
    const jobsText = await readOptionalText(jobsPath);
    if (jobsText.trim()) {
        const parsed = JSON.parse(jobsText);
        if (Array.isArray(parsed))
            return parsed.filter(isObject).map(toProcessingJob);
    }
    const stateText = await readOptionalText(join(peonPath, "brain", "processing-state.json"));
    if (!stateText.trim())
        return [];
    const state = JSON.parse(stateText);
    if (!isObject(state) || !state.lastStatus)
        return [];
    return [
        toProcessingJob({
            status: state.lastStatus,
            model: state.lastModel,
            reason: state.lastReason,
            estimatedTokens: state.lastEstimatedTokens
        })
    ];
}
function toProcessingJob(value) {
    return {
        status: typeof value.status === "string" ? value.status : undefined,
        model: typeof value.model === "string" ? value.model : undefined,
        reason: typeof value.reason === "string" ? value.reason : undefined,
        estimatedTokens: typeof value.estimatedTokens === "number" ? value.estimatedTokens : undefined
    };
}
async function readOptionalText(path) {
    return readFile(path, "utf8").catch((error) => {
        if (isObject(error) && error.code === "ENOENT")
            return "";
        throw error;
    });
}
function tokenize(value) {
    return Array.from(new Set(normalizeText(value).split(" ").filter((token) => token.length > 1)));
}
function normalizeText(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function ratio(numerator, denominator) {
    return denominator === 0 ? 1 : round4(numerator / denominator);
}
function round4(value) {
    return Math.round(value * 10000) / 10000;
}
function sourceRank(source) {
    return source === "retrieved" ? 0 : 1;
}
function observedKey(source, content) {
    return `${source}\0${content}`;
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
