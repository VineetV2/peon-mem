import { basename } from "node:path";
import { loadPeonConfig } from "./config.js";
import { createEmbeddingClient } from "./embeddings.js";
import { PeonMemoryStore } from "./memory-store.js";
import { PeonMemoryProcessor } from "./processor.js";
import { selectMemoryRecordsForContext } from "./retrieval.js";
import { createQualityReport } from "./quality.js";
import { PeonGlobalMemoryStore } from "./global-memory.js";
import { redactSecrets } from "./injection.js";
import { selectGloballyPromotable } from "./global-promotion.js";
import { createClusterSummarizer } from "./compression.js";
import { createGlobalExtractor } from "./global-extraction.js";
import { createRecurator } from "./recuration.js";
import { evaluatePeonProject } from "./evaluation.js";
import { buildContextInjection } from "./injection.js";
import { SessionIndex } from "./session-index.js";
export function createPeonTools(options = {}) {
    if (options.daemonUrl) {
        return createDaemonBackedTools(options.daemonUrl);
    }
    const storesByProject = new Map();
    const sessionIndex = new SessionIndex(options.sessionIndexPath);
    let globalStorePromise;
    async function storeFor(projectPath) {
        const existing = storesByProject.get(projectPath);
        if (existing)
            return existing;
        const store = await PeonMemoryStore.open({ projectPath });
        storesByProject.set(projectPath, store);
        return store;
    }
    async function storeForSession(sessionId) {
        const record = await sessionIndex.get(sessionId);
        if (!record)
            throw new Error(`Unknown Peon session: ${sessionId}`);
        const store = await storeFor(record.projectPath);
        // Rehydrate the session so record/end operations work after a daemon restart.
        store.ensureSession({
            id: record.sessionId,
            projectPath: record.projectPath,
            client: record.client,
            cwd: record.cwd,
            startedAt: record.startedAt
        });
        return store;
    }
    async function globalStore() {
        globalStorePromise ??= PeonGlobalMemoryStore.open({ globalDir: options.globalMemoryDir });
        return globalStorePromise;
    }
    return {
        async startSession(input) {
            const store = await storeFor(input.projectPath);
            const cwd = input.cwd ?? input.projectPath;
            const session = await store.startSession({ client: input.client, cwd });
            await sessionIndex.set({
                sessionId: session.id,
                projectPath: input.projectPath,
                client: input.client,
                cwd,
                startedAt: session.startedAt
            });
            return { sessionId: session.id, projectPath: input.projectPath };
        },
        async recordMessage(input) {
            const store = await storeForSession(input.sessionId);
            return store.recordMessage(input);
        },
        async recordEvent(input) {
            const store = await storeForSession(input.sessionId);
            return store.recordEvent(input);
        },
        async endSession(input) {
            const store = await storeForSession(input.sessionId);
            const result = await store.endSession(input);
            await sessionIndex.remove(input.sessionId);
            return result;
        },
        async getContext(input) {
            const store = await storeFor(input.projectPath);
            const context = await store.getContext({ query: input.query, maxChars: input.maxChars });
            // HIERARCHY: the global brain is the PARENT of every project brain — recall inherits from
            // it. Append the top query-relevant global beliefs as their own section (small budget,
            // redacted like everything else). Failures degrade silently — the project context stands.
            try {
                const g = (await (await globalStore()).search(input.query ?? "")).slice(0, 4);
                if (g.length > 0) {
                    context.global = redactSecrets(g.map((r) => "- [" + r.type + "] " + r.content).join("\n").slice(0, 1200));
                }
            }
            catch {
                // global brain unavailable — project-only context is still valid
            }
            return context;
        },
        async inspectBrain(input) {
            const store = await storeFor(input.projectPath);
            return store.inspectBrain({ query: input.query, maxChars: input.maxChars });
        },
        async searchMemory(input) {
            const store = await storeFor(input.projectPath);
            const ranked = await store.rankRecords(input.query, { limit: input.limit ?? 50 });
            const selected = selectMemoryRecordsForContext(ranked, {
                maxChars: input.maxChars ?? 4000,
                recordFormatter: formatRankedMemoryRecord
            });
            return {
                projectPath: input.projectPath,
                query: input.query,
                records: ranked,
                selected,
                injectionPreview: formatSearchInjectionPreview(selected.records)
            };
        },
        async qualityReport(input) {
            const store = await storeFor(input.projectPath);
            return createQualityReport(await store.listMemoryRecords(), {
                staleAfterDays: input.staleAfterDays
            });
        },
        async rememberGlobal(input) {
            return (await globalStore()).upsert({ ...input.memory, scope: "global" }, input.source);
        },
        async searchGlobalMemory(input) {
            return (await globalStore()).list(input);
        },
        async importGlobalMemory(input) {
            const store = await storeFor(input.projectPath);
            return (await globalStore()).importGlobalRecords(await store.listMemoryRecords(), {
                reason: `project-import:${input.projectPath}`
            });
        },
        async promoteToGlobal(input) {
            const store = await storeFor(input.projectPath);
            const promotable = selectGloballyPromotable(await store.listMemoryRecords());
            const global = await globalStore();
            const promoted = [];
            for (const record of promotable) {
                promoted.push(await global.upsert({
                    type: record.type,
                    content: record.content,
                    scope: "global",
                    importance: record.score.importance,
                    confidence: record.score.confidence,
                    entities: record.entities,
                    status: record.status
                }, { kind: "ai_processing", reason: `auto-promote:${input.projectPath}` }));
            }
            return { projectPath: input.projectPath, promoted };
        },
        async extractGlobal(input) {
            const extractor = createGlobalExtractor(loadPeonConfig());
            if (!extractor)
                return { promoted: [] };
            const store = await storeFor(input.projectPath);
            const facts = await extractor(await store.listMemoryRecords());
            const global = await globalStore();
            const promoted = [];
            for (const content of facts) {
                promoted.push(await global.upsert({ type: "fact", content, scope: "global", importance: 0.8, confidence: 0.8 }, { kind: "ai_processing", reason: `global-extract:${input.projectPath}` }));
            }
            return { promoted };
        },
        async recurateProject(input) {
            const recurator = createRecurator(loadPeonConfig());
            const store = await storeFor(input.projectPath);
            const records = await store.listMemoryRecords();
            const considered = records.filter((r) => r.status === "active" && !r.pinned).length;
            if (!recurator || considered === 0)
                return { archived: 0, considered };
            const dropIds = await recurator(records);
            // SAFETY CAP: trimming should remove a small minority. If the model wants to
            // drop more than 25%, it's misjudging the batch — refuse entirely rather than
            // gut the memory. (A real over-aggression incident is why this exists.)
            const MAX_FRACTION = 0.25;
            if (dropIds.length > Math.max(5, Math.floor(considered * MAX_FRACTION))) {
                return { archived: 0, considered, capped: true };
            }
            const archived = await store.archiveRecords(dropIds, "recurated under sharpened prompt");
            return { archived, considered };
        },
        async brainPass(input) {
            const store = await storeFor(input.projectPath);
            // Compression is the only LLM step — built in-process and only when asked
            // (the daemon enables it on the cost-gated consolidation path).
            const summarize = input.compress ? createClusterSummarizer(loadPeonConfig()) ?? undefined : undefined;
            return { actions: await store.runBrainPass({ recalledIds: input.recalledIds, summarize }) };
        },
        async globalBrainPass(input) {
            const summarize = input.compress ? createClusterSummarizer(loadPeonConfig()) ?? undefined : undefined;
            return { actions: await (await globalStore()).runBrainPass({ summarize }) };
        },
        async brainActivity(input) {
            const limit = input.limit ?? 30;
            const items = [];
            for (const projectPath of input.projectPaths) {
                const store = await storeFor(projectPath);
                for (const entry of await store.readBrainActions(10)) {
                    for (const action of entry.actions) {
                        items.push({ at: entry.at, scope: "project", projectName: basename(projectPath), type: action.type, detail: action.detail });
                    }
                }
            }
            for (const entry of await (await globalStore()).readBrainActions(10)) {
                for (const action of entry.actions) {
                    items.push({ at: entry.at, scope: "global", projectName: "global", type: action.type, detail: action.detail });
                }
            }
            return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
        },
        async globalDashboard() {
            const store = await globalStore();
            const records = await store.list({ status: "active" });
            const byType = {};
            const entityCounts = new Map();
            for (const record of records) {
                byType[record.type] = (byType[record.type] ?? 0) + 1;
                for (const entity of record.entities)
                    entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
            }
            const topEntities = Array.from(entityCounts.entries())
                .map(([entity, count]) => ({ entity, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 12);
            const recentActions = (await store.readBrainActions(10)).flatMap((entry) => entry.actions.map((action) => ({ at: entry.at, scope: "global", projectName: "global", type: action.type, detail: action.detail })));
            return {
                totalBeliefs: records.length,
                byType,
                topEntities,
                recentActions,
                records: records.slice(0, 50).map((r) => ({ id: r.id, type: r.type, content: r.content, entities: r.entities }))
            };
        },
        async brainActions(input) {
            const store = await storeFor(input.projectPath);
            return store.readBrainActions(input.limit);
        },
        async restoreBackup(input) {
            const store = await storeFor(input.projectPath);
            return { restored: await store.restoreLatestBackup() };
        },
        async updateMemory(input) {
            const store = await storeFor(input.projectPath);
            return store.updateMemoryRecord(input.id, {
                content: input.content,
                importance: input.importance,
                confidence: input.confidence,
                status: input.status,
                pinned: input.pinned
            });
        },
        async deleteMemory(input) {
            const store = await storeFor(input.projectPath);
            return { deleted: await store.deleteMemoryRecord(input.id) };
        },
        async mergeMemory(input) {
            const store = await storeFor(input.projectPath);
            return store.mergeMemoryRecords(input.keepId, input.dropId);
        },
        async evaluateProject(input) {
            return evaluatePeonProject(input);
        },
        async buildInjection(input) {
            const store = await storeFor(input.projectPath);
            const ranked = await store.rankRecords(input.query, { limit: 50 });
            const globalRecords = await (await globalStore()).list({ query: input.query });
            return buildContextInjection({
                projectResults: ranked,
                globalRecords,
                query: input.query,
                maxChars: input.maxChars ?? 6000,
                includeInactive: input.includeInactive
            });
        },
        async crossProjectSearch(input) {
            const targets = (input.projectPaths ?? []).filter((path) => path && path !== input.excludeProjectPath);
            const perProjectLimit = input.perProjectLimit ?? 6;
            const maxProjects = Math.max(1, input.maxProjects ?? 25);
            const terms = queryTerms(input.query);
            // Phase 1 — cheap lexical pre-filter: read each project's records (no embeddings)
            // and keep only those that mention the query at all, ranked by hit count. This
            // avoids doing the expensive semantic pass over dozens of irrelevant projects.
            const candidates = [];
            for (const projectPath of targets) {
                try {
                    const store = await storeFor(projectPath);
                    const active = (await store.listMemoryRecords()).filter((r) => r.status === "active");
                    const lex = lexicalProjectScore(active, terms);
                    // With a real query, require at least one lexical hit; with an empty query, keep all.
                    if (terms.length === 0 || lex > 0)
                        candidates.push({ projectPath, store, lex });
                }
                catch {
                    // skip a project we cannot read
                }
            }
            candidates.sort((left, right) => right.lex - left.lex);
            const shortlist = candidates.slice(0, maxProjects);
            // Embed the query ONCE and reuse it across the shortlisted projects.
            let queryVector;
            try {
                const client = createEmbeddingClient({ config: loadPeonConfig() });
                if (client)
                    [queryVector] = await client.embed([input.query]);
            }
            catch {
                // lexical-only if embeddings are unavailable
            }
            // Phase 2 — full (semantic) rank only on the shortlist.
            const hits = [];
            for (const { projectPath, store } of shortlist) {
                try {
                    const ranked = await store.rankRecordsReadonly(input.query, { limit: perProjectLimit, queryVector });
                    for (const item of ranked) {
                        if (item.record.status !== "active")
                            continue; // current beliefs only
                        hits.push({
                            projectPath,
                            projectName: basename(projectPath),
                            record: item.record,
                            score: item.score,
                            explanation: item.explanation
                        });
                    }
                }
                catch {
                    // skip a project that fails mid-rank; never fail the whole search
                }
            }
            hits.sort((left, right) => right.score - left.score);
            return {
                query: input.query,
                projectsSearched: shortlist.map((c) => c.projectPath),
                results: hits.slice(0, input.limit ?? 12)
            };
        },
        async processMemory(input) {
            const processor = new PeonMemoryProcessor();
            return processor.processMemory(input);
        },
        async maybeProcessMemory(input) {
            const processor = new PeonMemoryProcessor();
            return processor.maybeProcessMemory(input);
        }
    };
}
function createDaemonBackedTools(daemonUrl) {
    const baseUrl = daemonUrl.replace(/\/$/, "");
    return {
        async startSession(input) {
            return postJson(`${baseUrl}/sessions`, input);
        },
        async recordMessage(input) {
            return postJson(`${baseUrl}/messages`, input);
        },
        async recordEvent(input) {
            return postJson(`${baseUrl}/events`, input);
        },
        async endSession(input) {
            return postJson(`${baseUrl}/sessions/${encodeURIComponent(input.sessionId)}/end`, {});
        },
        async getContext(input) {
            const url = new URL(`${baseUrl}/context`);
            url.searchParams.set("projectPath", input.projectPath);
            if (input.query)
                url.searchParams.set("query", input.query);
            if (input.maxChars)
                url.searchParams.set("maxChars", String(input.maxChars));
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async inspectBrain(input) {
            const url = new URL(`${baseUrl}/brain`);
            url.searchParams.set("projectPath", input.projectPath);
            if (input.query)
                url.searchParams.set("query", input.query);
            if (input.maxChars)
                url.searchParams.set("maxChars", String(input.maxChars));
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async searchMemory(input) {
            const url = new URL(`${baseUrl}/search`);
            url.searchParams.set("projectPath", input.projectPath);
            url.searchParams.set("query", input.query);
            if (input.limit)
                url.searchParams.set("limit", String(input.limit));
            if (input.maxChars)
                url.searchParams.set("maxChars", String(input.maxChars));
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async qualityReport(input) {
            const url = new URL(`${baseUrl}/quality`);
            url.searchParams.set("projectPath", input.projectPath);
            if (input.staleAfterDays)
                url.searchParams.set("staleAfterDays", String(input.staleAfterDays));
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async rememberGlobal(input) {
            return postJson(`${baseUrl}/global/memories`, input);
        },
        async searchGlobalMemory(input) {
            const url = new URL(`${baseUrl}/global/memories`);
            if (input.query)
                url.searchParams.set("query", input.query);
            if (input.type)
                url.searchParams.set("type", input.type);
            if (input.status)
                url.searchParams.set("status", input.status);
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async importGlobalMemory(input) {
            return postJson(`${baseUrl}/global/import-project`, input);
        },
        async promoteToGlobal(input) {
            return postJson(`${baseUrl}/global/promote`, input);
        },
        async extractGlobal(input) {
            return postJson(`${baseUrl}/global/extract`, input);
        },
        async recurateProject(input) {
            return postJson(`${baseUrl}/recurate`, input);
        },
        async brainPass(input) {
            return postJson(`${baseUrl}/brain/pass`, input);
        },
        async globalBrainPass(input) {
            return postJson(`${baseUrl}/global/brain-pass`, input);
        },
        async brainActivity(input) {
            const url = new URL(`${baseUrl}/brain/activity`);
            if (input.limit)
                url.searchParams.set("limit", String(input.limit));
            return readJsonResponse(await fetch(url));
        },
        async globalDashboard() {
            return readJsonResponse(await fetch(`${baseUrl}/global/dashboard`));
        },
        async brainActions(input) {
            const url = new URL(`${baseUrl}/brain/actions`);
            url.searchParams.set("projectPath", input.projectPath);
            if (input.limit)
                url.searchParams.set("limit", String(input.limit));
            return readJsonResponse(await fetch(url));
        },
        async restoreBackup(input) {
            return postJson(`${baseUrl}/brain/restore`, input);
        },
        async updateMemory(input) {
            return postJson(`${baseUrl}/memory/update`, input);
        },
        async deleteMemory(input) {
            return postJson(`${baseUrl}/memory/delete`, input);
        },
        async mergeMemory(input) {
            return postJson(`${baseUrl}/memory/merge`, input);
        },
        async evaluateProject(input) {
            return postJson(`${baseUrl}/evaluate`, input);
        },
        async buildInjection(input) {
            const url = new URL(`${baseUrl}/injection`);
            url.searchParams.set("projectPath", input.projectPath);
            if (input.query)
                url.searchParams.set("query", input.query);
            if (input.maxChars)
                url.searchParams.set("maxChars", String(input.maxChars));
            if (input.includeInactive)
                url.searchParams.set("includeInactive", "true");
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async crossProjectSearch(input) {
            const url = new URL(`${baseUrl}/cross-context`);
            url.searchParams.set("query", input.query);
            if (input.excludeProjectPath)
                url.searchParams.set("exclude", input.excludeProjectPath);
            // A single explicit target maps to ?projectPath=; otherwise the daemon searches all known projects.
            if (input.projectPaths && input.projectPaths.length === 1) {
                url.searchParams.set("projectPath", input.projectPaths[0]);
            }
            if (input.limit)
                url.searchParams.set("limit", String(input.limit));
            if (input.maxProjects)
                url.searchParams.set("maxProjects", String(input.maxProjects));
            const response = await fetch(url);
            return readJsonResponse(response);
        },
        async processMemory(input) {
            return postJson(`${baseUrl}/process`, input);
        },
        async maybeProcessMemory(input) {
            return postJson(`${baseUrl}/process/auto`, input);
        }
    };
}
function formatRankedMemoryRecord(item) {
    return `- [${item.record.type}] ${item.record.content}\n  why: ${item.explanation}\n`;
}
const CROSS_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "for", "in", "is", "of", "on", "or", "the", "to", "use", "with", "what", "did", "we", "our", "about", "from"]);
function queryTerms(query) {
    return [
        ...new Set((query ?? "")
            .toLowerCase()
            .split(/[^a-z0-9_.\/-]+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 1 && !CROSS_STOP_WORDS.has(t)))
    ];
}
/** Cheap lexical relevance for the cross-project pre-filter: how many active records mention a query term. */
function lexicalProjectScore(records, terms) {
    if (terms.length === 0)
        return records.length;
    let score = 0;
    for (const record of records) {
        const haystack = `${record.content} ${record.normalized} ${record.entities.join(" ")}`.toLowerCase();
        if (terms.some((term) => haystack.includes(term)))
            score += 1;
    }
    return score;
}
function formatSearchInjectionPreview(records) {
    if (records.length === 0)
        return "";
    return ["Peon Search Results", ...records.map(formatRankedMemoryRecord)].join("\n");
}
async function postJson(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    return readJsonResponse(response);
}
async function readJsonResponse(response) {
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
        const message = typeof body.error === "string" ? body.error : `Peon daemon request failed: ${response.status}`;
        throw new Error(message);
    }
    return body;
}
