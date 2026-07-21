import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadPeonConfig } from "./config.js";
import { EmbeddingStore } from "./embedding-store.js";
import { cosineSimilarity, createEmbeddingClient } from "./embeddings.js";
import { applyDelete, applyMerge, applyPin, applyUpdate } from "./memory-mutations.js";
import { runSleepCycle } from "./brain.js";
import { readdir, rm } from "node:fs/promises";
import { rankMemoryRecords as rankWithRetrieval, computeGraphActivation, diversifyByMMR } from "./retrieval.js";
import { currentAsOf, changesBetween } from "./temporal.js";
import { inferCanonicalEntities, buildEntityRegistry, canonicalizeEntity } from "./entities.js";
import { redactSecrets } from "./injection.js";
/**
 * Per-project write serialization. The daemon is one process but opens MORE THAN ONE store
 * instance for the same project (the cached store for record/getContext + a fresh one inside
 * the consolidation processor), and overlapping triggers (turn-end, SubagentStop, session-end,
 * heartbeat) can run read-modify-write on the same memories.jsonl concurrently. Without a lock,
 * the later full-file overwrite silently drops the earlier run's supersede flips and adds.
 * This module-level map keys a promise-chain mutex by the resolved memory dir, so it serializes
 * ACROSS instances within the process. Not reentrant — only the outermost public mutator locks.
 */
const projectWriteLocks = new Map();
function withProjectWriteLock(key, fn) {
    const prev = projectWriteLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of how the previous holder settled
    projectWriteLocks.set(key, run.then(() => undefined, () => undefined));
    return run;
}
/** Crash-safe write: stage to a sibling .tmp then atomically rename over the target. */
async function atomicWrite(path, content) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
}
export class PeonMemoryStore {
    projectPath;
    memoryDir;
    embeddingClient;
    sessions = new Map();
    embeddingStore;
    constructor(projectPath, memoryDir, embeddingClient) {
        this.projectPath = projectPath;
        this.memoryDir = memoryDir;
        this.embeddingClient = embeddingClient;
    }
    static async open(options) {
        // Path-traversal guard: never open a store at a path containing ".." segments — a daemon
        // caller must not be able to escape to an arbitrary location and create/overwrite a brain.
        if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(options.projectPath)) {
            throw new Error(`Unsafe projectPath (contains "..") : ${options.projectPath}`);
        }
        const config = options.config ?? loadPeonConfig();
        const memoryDir = join(options.projectPath, options.memoryDirName ?? config.memoryDirName ?? ".peon");
        const embeddingClient = options.embeddingClient !== undefined ? options.embeddingClient : createEmbeddingClient({ config });
        const store = new PeonMemoryStore(options.projectPath, memoryDir, embeddingClient);
        await store.ensureLayout();
        store.embeddingStore = await EmbeddingStore.open(memoryDir);
        return store;
    }
    async startSession(input) {
        const session = {
            id: crypto.randomUUID(),
            projectPath: this.projectPath,
            client: input.client,
            cwd: input.cwd,
            startedAt: new Date().toISOString()
        };
        this.sessions.set(session.id, session);
        await this.appendJsonl("raw/events.jsonl", {
            id: crypto.randomUUID(),
            sessionId: session.id,
            type: "session_started",
            content: `Session started for ${input.client}`,
            createdAt: session.startedAt
        });
        return session;
    }
    /**
     * Rehydrate a session into memory if it isn't already known. Called by the
     * tools layer after resolving a sessionId from the durable session index, so
     * record/end operations succeed even after a daemon restart. Idempotent.
     */
    ensureSession(session) {
        if (!this.sessions.has(session.id)) {
            this.sessions.set(session.id, session);
        }
    }
    async recordMessage(input) {
        const event = await this.record({
            sessionId: input.sessionId,
            type: "message",
            role: input.role,
            content: input.content
        });
        await this.appendJsonl("raw/messages.jsonl", event);
        return event;
    }
    async recordEvent(input) {
        const event = await this.record(input);
        await this.appendJsonl("raw/events.jsonl", event);
        if (event.type === "tool_use") {
            await this.appendJsonl("raw/tool-calls.jsonl", event);
        }
        await this.updateBrain(event);
        return event;
    }
    async endSession(input) {
        const session = this.requireSession(input.sessionId);
        const ended = { ...session, endedAt: new Date().toISOString() };
        this.sessions.set(ended.id, ended);
        await this.appendJsonl("raw/events.jsonl", {
            id: crypto.randomUUID(),
            sessionId: ended.id,
            type: "session_ended",
            content: "Session ended",
            createdAt: ended.endedAt
        });
        await this.writeSessionSummary(ended);
        // Do NOT rebuild project-summary.md here — the AI processor owns that file.
        // Overwriting it with raw in-memory events would clobber any AI-generated summary.
        return ended;
    }
    async getContext(input = {}) {
        const maxChars = normalizeContextBudget(input.maxChars);
        // Query-FOCUSED injection: every section is built from beliefs the ranker judged
        // relevant to THIS prompt (RRF + semantic + recency + reinforcement), then diversified
        // by MMR — instead of dumping whole brain .md files and text-trimming them. So when the
        // user asks about X, the injected decisions/preferences/etc. are about X, not the entire
        // brain. Irrelevant sections come back empty and drop out, keeping the block small.
        // NOTE: expandGraph is intentionally OFF here. The labeled eval harness (eval-metrics +
        // scripts/eval-retrieval-labeled.mjs) showed fusing entity-graph activation into the ranking
        // does NOT improve top-K injection relevance (neutral at low weight, −2.9% Recall@10 at 0.5):
        // shared-entity association ≠ question-relevance, so it trades away relevant direct hits. The
        // graph stays an opt-in capability (rankRecords({expandGraph}) / expandByEntityGraph) + the
        // entity registry/graph.json structure — not a tax on every injection.
        const ranked = diversifyByMMR(await this.rankRecords(input.query, { limit: 40 }));
        const active = ranked.filter((item) => item.record.status === "active");
        // The active beliefs DIRECTLY recalled for this prompt — reinforcement fuel. Exclude
        // graph-neighbour beliefs (pulled in by association, not matched by the query) so they
        // aren't reinforced as if the user's prompt recalled them.
        const recalledIds = active
            .filter((item) => !item.explanation.startsWith("linked via entity"))
            .slice(0, 12)
            .map((item) => item.record.id);
        // Episodic layer ON by default: the consolidated belief layer is a lossy gist, so without
        // this a question like "what were the professor's 3 ideas" gets the summary, not the verbatim
        // answer that's sitting in the recorded session. Opt OUT with includeEpisodes:false.
        const episodes = input.includeEpisodes !== false && (input.query ?? "").trim().length > 0
            ? formatEpisodes(await this.rankEpisodes(input.query, { limit: 6 }), Math.floor(maxChars * 0.35))
            : "";
        // HYBRID per-section source: prefer query-ranked belief RECORDS of that type (the consolidated
        // brain — already relevance-ranked, so the section is about what was asked). Fall back to the
        // real-time .md file when no such beliefs exist yet (pre-consolidation, or types written live by
        // recordEvent before the AI distills them). This keeps injection query-focused once the brain is
        // built, without losing the immediate real-time view.
        const ofType = (...types) => active.filter((item) => types.includes(item.record.type));
        const section = async (records, file, title, frac) => {
            const budget = Math.floor(maxChars * frac);
            if (records.length > 0)
                return formatContextRecords(records, budget, title);
            return compactMemoryText(await this.readBrainFile(file), { maxChars: budget, query: input.query, title });
        };
        const summarySource = await this.readBrainFile("project-summary.md");
        const sections = {
            summary: compactMemoryText(summarySource, { maxChars: Math.floor(maxChars * 0.18), query: input.query, title: "Project Summary" }),
            // The headline "most relevant overall" beliefs, with scores — kept in the original format.
            memories: compactMemoryText(formatRankedMemoryRecords(active), { maxChars: Math.floor(maxChars * 0.22), query: input.query, title: "Structured Memory" }),
            decisions: await section(ofType("decision"), "decisions.md", "Decisions", 0.14),
            preferences: await section(ofType("preference"), "preferences.md", "Preferences", 0.12),
            openQuestions: await section(ofType("open_question"), "open-questions.md", "Open Questions", 0.10),
            artifacts: await section(ofType("artifact"), "artifacts.md", "Artifacts", 0.10),
            timeline: await section(ofType("timeline"), "timeline.md", "Timeline", 0.12)
        };
        // `compacted` reflects whether the RAW brain material exceeded the budget (so callers know
        // the view was trimmed) — measured from sources, not the already-budgeted section output.
        const rawSize = summarySource.length +
            formatRankedMemoryRecords(active).length +
            (await Promise.all(["decisions.md", "preferences.md", "open-questions.md", "artifacts.md", "timeline.md"].map((f) => this.readBrainFile(f))))
                .reduce((n, s) => n + s.length, 0);
        const originalChars = rawSize;
        // Redact secrets at the injection boundary — getContext is the hook's injection path and
        // (unlike buildContextInjection) was emitting belief/episode text unredacted.
        const safeSections = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, redactSecrets(v)]));
        // Headline: the first GENUINELY query-matching belief, hoisted so the injection LEADS with it.
        // Gate on real match signal (query-term / file / matched-entity / a real semantic hit) — NOT
        // recency/reinforcement — so a recently-touched but irrelevant belief can't be paraded as "most
        // relevant" (a banner is only useful if it's trustworthy). Skip graph-neighbours and the no-query
        // startup path. If nothing genuinely matches, emit no banner rather than a misleading one.
        const genuinelyMatches = (item) => item.reasons.some((r) => r.kind === "query_term" ||
            r.kind === "file" ||
            (r.kind === "entity" && r.label !== "linked via entity graph") ||
            (r.kind === "semantic" && r.score >= 0.4));
        const headlineRecord = (input.query ?? "").trim().length > 0
            ? active.find((item) => !item.explanation.startsWith("linked via entity") && genuinelyMatches(item))?.record
            : undefined;
        const headline = headlineRecord ? redactSecrets(`[${headlineRecord.type}] ${headlineRecord.content}`) : undefined;
        return {
            ...safeSections,
            ...(episodes ? { episodes: redactSecrets(episodes) } : {}),
            meta: {
                compacted: originalChars > maxChars,
                maxChars
            },
            recalledIds,
            ...(headline ? { headline } : {})
        };
    }
    async inspectBrain(input = {}) {
        const context = await this.getContext(input);
        // FULL record set — inspection/counts must see the whole brain, not a ranked top-K slice
        // (that bug made /overview report ~50 beliefs for a 1400+ belief brain). The query-relevant
        // CONTENT still comes from `context` / `injectionPreview`, which stay ranked and compact.
        const records = await this.listMemoryRecords();
        return {
            projectPath: this.projectPath,
            query: input.query,
            records,
            graph: await this.readMemoryGraph(),
            injectionPreview: formatInjectionPreview(context),
            context
        };
    }
    async listMemoryRecords() {
        return this.readMemoryRecords();
    }
    /** Serialize a read-modify-write transaction against this project's brain (see projectWriteLocks). */
    withWriteLock(fn) {
        return withProjectWriteLock(this.memoryDir, fn);
    }
    /**
     * Run a multi-step read-modify-write as ONE serialized critical section against this project's
     * brain — even across separate store instances in the process. Callers must NOT invoke other
     * locking mutators inside `fn` (the lock is not reentrant); use the lock-free internals
     * (applyProcessedMemory, mergeSimilarActiveRecords, replaceMemoryRecords) directly.
     */
    runExclusive(fn) {
        return this.withWriteLock(fn);
    }
    async replaceMemoryRecords(records) {
        await atomicWrite(join(this.memoryDir, "brain", "memories.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""));
        await atomicWrite(join(this.memoryDir, "brain", "graph.json"), `${JSON.stringify(buildMemoryGraph(basename(this.projectPath), records), null, 2)}\n`);
        // Canonical entity registry — derived from records (observable, like graph.json), atomic.
        const { entities } = buildEntityRegistry(records.flatMap((record) => record.entities));
        await atomicWrite(join(this.memoryDir, "brain", "entities.jsonl"), entities.map((entity) => JSON.stringify(entity)).join("\n") + (entities.length > 0 ? "\n" : ""));
        // Keep vector embeddings in lock-step with the structured records.
        await this.embeddingStore?.sync(records, this.embeddingClient);
    }
    /** Edit a belief in place (content, scores, status, or pin). Returns the updated record, or null if unknown. */
    async updateMemoryRecord(id, patch) {
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            if (!records.some((record) => record.id === id))
                return null;
            const next = applyUpdate(records, id, patch, new Date().toISOString());
            await this.replaceMemoryRecords(next);
            return next.find((record) => record.id === id) ?? null;
        });
    }
    /** Delete a belief outright. Returns true if a record was removed. */
    async deleteMemoryRecord(id) {
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            const next = applyDelete(records, id);
            if (next.length === records.length)
                return false;
            await this.replaceMemoryRecords(next);
            return true;
        });
    }
    /** Pin/unpin a belief. Returns the updated record, or null if unknown. */
    async setMemoryRecordPinned(id, pinned) {
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            if (!records.some((record) => record.id === id))
                return null;
            const next = applyPin(records, id, pinned, new Date().toISOString());
            await this.replaceMemoryRecords(next);
            return next.find((record) => record.id === id) ?? null;
        });
    }
    /** Fold one belief into another. Returns the surviving record, or null if either id is unknown. */
    async mergeMemoryRecords(keepId, dropId) {
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            const next = applyMerge(records, keepId, dropId, new Date().toISOString());
            if (next.length === records.length && keepId !== dropId)
                return null;
            await this.replaceMemoryRecords(next);
            return next.find((record) => record.id === keepId) ?? null;
        });
    }
    /**
     * Run one autonomous brain pass (the "sleep cycle"): snapshot a backup, then
     * reinforce / resolve conflicts / merge duplicates / compress topic clusters.
     * Every change is recoverable from the snapshot. Returns the actions taken.
     */
    async runBrainPass(options = {}) {
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            if (records.length === 0)
                return [];
            const now = new Date().toISOString();
            await this.snapshotBackup(records, now);
            const { records: curated, actions } = await runSleepCycle(records, {
                recalledIds: options.recalledIds,
                now,
                summarize: options.summarize,
                minClusterSize: options.minClusterSize,
                makeSummaryId: (entity) => `mem_summary_${stableMemoryId("summary", entity).slice(-12)}`
            });
            if (actions.length === 0) {
                // Reinforcement-only strength tweaks still matter; persist them quietly.
                await this.replaceMemoryRecords(curated);
                return [];
            }
            await this.replaceMemoryRecords(curated);
            await this.appendJsonl("brain/brain-actions.jsonl", { at: now, actions });
            return actions;
        });
    }
    /** Archive a set of beliefs (recoverable) after snapshotting a backup. Returns how many were archived. */
    async archiveRecords(ids, reason) {
        if (ids.length === 0)
            return 0;
        return this.withWriteLock(async () => {
            const records = await this.readMemoryRecords();
            const idSet = new Set(ids);
            const now = new Date().toISOString();
            await this.snapshotBackup(records, now);
            let archived = 0;
            const next = records.map((record) => {
                if (idSet.has(record.id) && record.status === "active" && !record.pinned) {
                    archived += 1;
                    return { ...record, status: "archived", updatedAt: now, source: { ...record.source, reason } };
                }
                return record;
            });
            if (archived > 0)
                await this.replaceMemoryRecords(next);
            return archived;
        });
    }
    /** Recent autonomous actions the brain took — powers the cockpit "what the brain did" feed. */
    async readBrainActions(limit = 50) {
        const rows = await this.readJsonl("brain/brain-actions.jsonl");
        return rows.slice(-limit).reverse();
    }
    async snapshotBackup(records, now) {
        const dir = join(this.memoryDir, "brain", "backups");
        await mkdir(dir, { recursive: true });
        const stamp = now.replace(/[:.]/g, "-");
        await writeFile(join(dir, `memories-${stamp}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
        // Keep only the most recent 20 snapshots.
        const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith("memories-")).sort();
        for (const stale of files.slice(0, Math.max(0, files.length - 20))) {
            await rm(join(dir, stale), { force: true }).catch(() => undefined);
        }
    }
    /** Restore the project's beliefs from the most recent backup snapshot. Returns true if restored. */
    async restoreLatestBackup() {
        // Serialize against consolidation/merge — a restore is a read-modify-write of the brain and
        // must not race the heartbeat (otherwise a concurrent consolidation can clobber the restore).
        return this.withWriteLock(async () => {
            const dir = join(this.memoryDir, "brain", "backups");
            const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith("memories-")).sort();
            const latest = files.at(-1);
            if (!latest)
                return false;
            const raw = await readFile(join(dir, latest), "utf8").catch(() => "");
            const records = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((l) => {
                try {
                    return [JSON.parse(l)];
                }
                catch {
                    return [];
                }
            });
            if (records.length === 0)
                return false;
            await this.replaceMemoryRecords(records);
            return true;
        });
    }
    /**
     * Rank memory records for a query using hybrid lexical + semantic retrieval.
     * The single retrieval entry point: embeds the query (if embeddings are on),
     * loads stored vectors, and blends cosine similarity into the lexical score.
     */
    /** Time-travel: the beliefs that were current as of `at`. */
    async currentAsOf(at) {
        return currentAsOf(await this.readMemoryRecords(), at);
    }
    /** Time-travel: the changelog (added / superseded / retired) over [from, to]. */
    async changesBetween(from, to) {
        return changesBetween(await this.readMemoryRecords(), from, to);
    }
    /**
     * EPISODIC retrieval — rank the raw conversational turns (not the consolidated beliefs) by
     * relevance to a query. Consolidation is lossy by design: it distills experience into durable
     * beliefs and drops episodic specifics ("the GPS was not functioning" becomes "interested in
     * GPS features"). For questions that hinge on those specifics, retrieving over the raw record
     * recovers the detail the belief layer compressed away. This is the high-recall episodic layer
     * that complements the high-precision belief layer; callers can blend both. Lexical-ranked
     * (raw turns carry no precomputed embeddings) and read-only — it never mutates the store.
     */
    async rankEpisodes(query, options = {}) {
        const [messages, events] = await Promise.all([
            this.readJsonl("raw/messages.jsonl"),
            this.readJsonl("raw/events.jsonl")
        ]);
        // Tool-call dumps (Bash/Edit/Write payloads) are huge and low-signal for "what was discussed";
        // rank over substantive conversational turns instead so verbatim answers surface, not noise.
        const TOOL_TYPES = new Set(["tool_use", "tool_result"]);
        const substantive = [...messages, ...events].filter((e) => typeof e.content === "string" && e.content.trim().length > 0 && !TOOL_TYPES.has(String(e.type)));
        // LEXICAL PREFILTER — bound the per-prompt cost. rankWithRetrieval below ranks episodes with
        // NO semantic input (lexical-only), so an episode can only score if its text lexically matches
        // a query token. Restricting the expensive map + inferEntities + rank to lexically-matching
        // entries therefore drops NOTHING the ranker would have surfaced, while turning an O(all session
        // history) scan on every prompt into O(matches). With no query we keep the most recent slice.
        const tokens = (query ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
        const EXPENSIVE_CAP = 500;
        let candidates = substantive;
        if (tokens.length > 0) {
            candidates = substantive.filter((e) => {
                const c = String(e.content).toLowerCase();
                return tokens.some((t) => c.includes(t));
            });
        }
        if (candidates.length > EXPENSIVE_CAP) {
            // A near-stopword token can still match a huge slice; keep the most RECENT matches so a
            // pathological query can't reintroduce the unbounded cost.
            candidates = candidates
                .slice()
                .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
                .slice(0, EXPENSIVE_CAP);
        }
        const episodes = candidates
            .map((e) => {
            const content = String(e.content);
            const when = String(e.createdAt ?? "");
            const role = typeof e.role === "string" ? e.role : undefined;
            return {
                id: String(e.id ?? `${when}:${content.slice(0, 24)}`),
                type: "timeline",
                content: role ? `${role}: ${content}` : content,
                normalized: content.toLowerCase(),
                scope: "project",
                status: "active",
                score: { importance: 0.5, confidence: 0.6 },
                source: { kind: "manual" },
                entities: inferEntities(content),
                createdAt: when,
                updatedAt: when
            };
        });
        if (episodes.length === 0)
            return [];
        return rankWithRetrieval(episodes, query, { limit: options.limit ?? 20 });
    }
    async rankRecords(query, options = {}) {
        const records = await this.readMemoryRecords();
        const semantic = await this.buildSemanticInput(query, records);
        const limit = options.limit ?? 50;
        const direct = rankWithRetrieval(records, query, { limit, semantic });
        if (!options.expandGraph || direct.length === 0)
            return direct;
        // FUSED associative recall: spread activation from the direct hits through the entity graph,
        // then RE-RANK with that activation as a (damped) signal — so a strongly-associated belief can
        // enter the top-K and displace a weak direct hit, instead of being appended out of the window.
        const graphActivation = computeGraphActivation(direct, records);
        if (graphActivation.size === 0)
            return direct;
        return rankWithRetrieval(records, query, { limit, semantic, graphActivation });
    }
    /**
     * Rank records WITHOUT mutating anything — uses only embeddings already on disk
     * (no sync, no recompute, no writes). For read-only cross-project recall, where
     * we must never modify another project's brain. An optional precomputed query
     * vector lets the caller embed the query once and reuse it across many projects.
     */
    async rankRecordsReadonly(query, options = {}) {
        const records = await this.readMemoryRecords();
        let semantic;
        if (query && query.trim() && this.embeddingStore && records.length > 0) {
            try {
                const vectorById = await this.embeddingStore.vectorById();
                let queryVector = options.queryVector;
                if ((!queryVector || queryVector.length === 0) && this.embeddingClient) {
                    [queryVector] = await this.embeddingClient.embed([query]);
                }
                if (queryVector && queryVector.length > 0 && vectorById.size > 0) {
                    semantic = { queryVector, vectorById };
                }
            }
            catch {
                // lexical-only on any embedding failure
            }
        }
        return rankWithRetrieval(records, query, { limit: options.limit ?? 50, semantic });
    }
    async buildSemanticInput(query, records) {
        if (!query || !query.trim() || !this.embeddingClient || !this.embeddingStore || records.length === 0) {
            return undefined;
        }
        try {
            // READ-ONLY on the prompt hot path: use vectors already on disk (mtime-cached) — never
            // sync/recompute/rewrite the multi-MB sidecar here. Backfill happens on the WRITE path
            // (replaceMemoryRecords → sync, under the write lock), so vectors stay current after any
            // mutation; records added since the last write degrade to lexical until the next consolidation.
            const vectorById = await this.embeddingStore.vectorById();
            if (vectorById.size === 0)
                return undefined;
            const [queryVector] = await this.embeddingClient.embed([query]);
            if (!queryVector || queryVector.length === 0)
                return undefined;
            return { queryVector, vectorById };
        }
        catch {
            // Embedding failures degrade gracefully to lexical-only retrieval.
            return undefined;
        }
    }
    async writeQualityReport(report) {
        await writeFile(join(this.memoryDir, "brain", "quality-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    async readRawMemory(maxChars = 12000) {
        const [messages, events] = await Promise.all([
            this.readJsonl("raw/messages.jsonl"),
            this.readJsonl("raw/events.jsonl")
        ]);
        const formatted = [...messages, ...events]
            .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")))
            .map((entry) => {
            const role = entry.role ? `${entry.role}: ` : "";
            return `[${entry.createdAt ?? "unknown"}] ${entry.type ?? "memory"} ${role}${entry.content ?? ""}`;
        })
            .join("\n");
        return formatted.length > maxChars ? formatted.slice(-maxChars) : formatted;
    }
    /**
     * Read only the raw events that arrived AFTER `afterEventId` (the delta cursor),
     * so consolidation processes new experience instead of re-reading a window.
     * Falls back to the full sliding window when the cursor is unset or no longer
     * present (e.g. logs rotated) — never silently skips events. The delta is capped
     * to `maxChars` (default 60k, env PEON_CONSOLIDATION_MAX_DELTA_CHARS); `lastEventId`
     * is the last INCLUDED event (the next cursor) and `capped` is true when the delta
     * was cut short — the caller must then keep the char-gate open so the rest drains.
     */
    async readRawMemoryDelta(afterEventId, maxChars) {
        // Bound how much delta is handed to the model in one consolidation. A huge backlog (big brain +
        // a fat session) overflowed the completion window and truncated the JSON reply mid-object, which
        // never parses — so the batch failed and (correctly, cursor unmoved) retried the SAME oversized
        // delta forever: a permanent stall. Consume a bounded chunk, advance the cursor only to the last
        // INCLUDED event, and let the next trigger drain the rest.
        const cap = maxChars ?? (Number(process.env.PEON_CONSOLIDATION_MAX_DELTA_CHARS) || 60000);
        const [messages, events] = await Promise.all([
            this.readJsonl("raw/messages.jsonl"),
            this.readJsonl("raw/events.jsonl")
        ]);
        const sorted = [...messages, ...events].sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
        let slice = sorted;
        if (afterEventId) {
            const index = sorted.findIndex((entry) => entry.id === afterEventId);
            // Cursor present → everything after it. Cursor lost (log rotated/compacted) → fall back to
            // the full window rather than silently skipping; the char cap below still bounds it.
            slice = index >= 0 ? sorted.slice(index + 1) : sorted;
        }
        const lines = [];
        let total = 0;
        let boundaryId = afterEventId;
        let capped = false;
        for (const entry of slice) {
            const role = entry.role ? `${entry.role}: ` : "";
            let line = `[${entry.createdAt ?? "unknown"}] ${entry.type ?? "memory"} ${role}${entry.content ?? ""}`;
            // A single oversized event (e.g. a giant tool output) is truncated so we always make progress.
            if (line.length > cap)
                line = line.slice(0, cap);
            if (lines.length > 0 && total + line.length + 1 > cap) {
                capped = true;
                break;
            }
            lines.push(line);
            total += line.length + 1;
            boundaryId = entry.id ?? boundaryId;
        }
        return { text: lines.join("\n"), lastEventId: boundaryId, capped };
    }
    async applyProcessedMemory(memory, source = {}, modelEntities) {
        const summary = [
            "# Project Summary",
            "",
            `Project: ${basename(this.projectPath)}`,
            "",
            "## AI Summary",
            memory.summary || "No AI summary produced.",
            ""
        ];
        await writeFile(join(this.memoryDir, "brain", "project-summary.md"), `${summary.join("\n")}\n`, "utf8");
        await this.appendList("brain/decisions.md", memory.decisions);
        await this.appendList("brain/preferences.md", memory.preferences);
        await this.appendList("brain/open-questions.md", memory.openQuestions);
        await this.appendList("brain/artifacts.md", memory.artifacts);
        await this.appendList("brain/timeline.md", memory.timeline);
        return this.applyStructuredMemory(memory, source, modelEntities);
    }
    /**
     * Merge near-duplicate ACTIVE records by embedding similarity. Models sometimes
     * record the same belief twice (e.g. a supersede replacement AND a paraphrase in
     * decisions[]); lexical dedup misses these because the wording differs. With real
     * (API) embeddings this catches the paraphrase and keeps a single current truth.
     * No-op when embeddings are unavailable. supersededBy links to a merged-away id
     * are re-pointed at the surviving record so history stays intact.
     */
    async mergeSimilarActiveRecords(records, threshold = 0.9) {
        if (!this.embeddingClient || !this.embeddingStore)
            return { records, merged: 0 };
        let vectorById;
        try {
            vectorById = (await this.embeddingStore.sync(records, this.embeddingClient)).vectorById;
        }
        catch {
            return { records, merged: 0 };
        }
        if (vectorById.size === 0)
            return { records, merged: 0 };
        const active = records.filter((record) => record.status === "active");
        const passthrough = records.filter((record) => record.status !== "active");
        const kept = [];
        const retired = []; // merged-away losers, kept recoverable (not destroyed)
        const remap = new Map();
        const mergeNow = new Date().toISOString();
        let merged = 0;
        for (const record of active) {
            const vec = vectorById.get(record.id);
            let matchIndex = -1;
            if (vec) {
                for (let i = 0; i < kept.length; i += 1) {
                    if (kept[i].type !== record.type)
                        continue;
                    const other = vectorById.get(kept[i].id);
                    if (other && cosineSimilarity(vec, other) >= threshold) {
                        matchIndex = i;
                        break;
                    }
                }
            }
            if (matchIndex === -1) {
                kept.push(record);
                continue;
            }
            const other = kept[matchIndex];
            const canonical = recordStrength(record) > recordStrength(other) ? record : other;
            const loser = canonical === record ? other : record;
            kept[matchIndex] = {
                ...canonical,
                score: {
                    importance: Math.max(record.score.importance, other.score.importance),
                    confidence: Math.max(record.score.confidence, other.score.confidence)
                },
                entities: unique([...record.entities, ...other.entities]),
                updatedAt: record.updatedAt > other.updatedAt ? record.updatedAt : other.updatedAt
            };
            remap.set(loser.id, canonical.id);
            // Recoverable-loser rule: don't destroy the merged-away belief — retire it as superseded,
            // linked to the survivor. It leaves active recall but its content stays recoverable and
            // history stays intact (a still-true minority phrasing is never silently lost).
            retired.push({ ...loser, status: "superseded", supersededBy: canonical.id, updatedAt: mergeNow });
            merged += 1;
        }
        // Resolve remap to a FIXED POINT: in a multi-level chain (A→B then B→C) a one-hop remap would
        // leave A pointing at the now-merged-away B. Follow the chain (cycle-guarded) to the survivor.
        const resolveRemap = (id) => {
            let cur = id;
            const seen = new Set();
            while (remap.has(cur) && !seen.has(cur)) {
                seen.add(cur);
                cur = remap.get(cur);
            }
            return cur;
        };
        const fixed = [...passthrough, ...retired].map((record) => record.supersededBy && remap.has(record.supersededBy)
            ? { ...record, supersededBy: resolveRemap(record.supersededBy) }
            : record);
        return { records: [...kept, ...fixed], merged };
    }
    async readProcessingState() {
        const raw = await readFile(join(this.memoryDir, "brain", "processing-state.json"), "utf8").catch(() => "");
        if (!raw.trim())
            return {};
        try {
            return JSON.parse(raw);
        }
        catch {
            return {};
        }
    }
    async writeProcessingState(state) {
        await writeFile(join(this.memoryDir, "brain", "processing-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }
    async ensureLayout() {
        // A brand-new brain is born ROOTED: the `.peon/root` marker makes it a self-contained CHILD
        // brain under Peon's global (parent) brain, so the topmost-climb rule can never swallow a new
        // project into an ancestor catch-all again (the old "Documents became the main brain" failure).
        const fresh = !existsSync(join(this.memoryDir, "brain", "memories.jsonl"));
        await mkdir(join(this.memoryDir, "raw"), { recursive: true });
        await mkdir(join(this.memoryDir, "brain"), { recursive: true });
        await mkdir(join(this.memoryDir, "sessions"), { recursive: true });
        await Promise.all([
            this.ensureFile("raw/events.jsonl", ""),
            this.ensureFile("raw/messages.jsonl", ""),
            this.ensureFile("raw/tool-calls.jsonl", ""),
            this.ensureFile("brain/project-summary.md", `# Project Summary\n\nProject: ${basename(this.projectPath)}\n`),
            this.ensureFile("brain/decisions.md", "# Decisions\n"),
            this.ensureFile("brain/preferences.md", "# Preferences\n"),
            this.ensureFile("brain/open-questions.md", "# Open Questions\n"),
            this.ensureFile("brain/artifacts.md", "# Artifacts\n"),
            this.ensureFile("brain/timeline.md", "# Timeline\n"),
            this.ensureFile("brain/memories.jsonl", ""),
            this.ensureFile("brain/graph.json", JSON.stringify(emptyGraph(), null, 2) + "\n"),
            this.ensureFile("brain/processing-state.json", "{}\n")
        ]);
        if (fresh) {
            await writeFile(join(this.memoryDir, "root"), "brain boundary - child brain of the Peon global brain\n", "utf8").catch(() => undefined);
        }
    }
    async ensureFile(relativePath, content) {
        const path = join(this.memoryDir, relativePath);
        try {
            await readFile(path, "utf8");
        }
        catch {
            await writeFile(path, content, "utf8");
        }
    }
    requireSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            throw new Error(`Unknown Peon session: ${sessionId}`);
        return session;
    }
    async record(input) {
        this.requireSession(input.sessionId);
        const event = {
            id: crypto.randomUUID(),
            sessionId: input.sessionId,
            type: input.type,
            content: input.content,
            role: input.role,
            createdAt: new Date().toISOString()
        };
        await this.appendTimeline(event);
        return event;
    }
    async updateBrain(event) {
        if (event.type === "decision") {
            await this.appendMarkdown("brain/decisions.md", `- ${event.content}\n`);
            return;
        }
        if (event.type === "preference") {
            await this.appendMarkdown("brain/preferences.md", `- ${event.content}\n`);
            return;
        }
        if (event.type === "open_question") {
            await this.appendMarkdown("brain/open-questions.md", `- ${event.content}\n`);
        }
    }
    async appendTimeline(event) {
        await this.appendMarkdown("brain/timeline.md", `- ${event.createdAt} [${event.type}] ${event.content}\n`);
    }
    async writeSessionSummary(session) {
        // Read this session's events from disk (not an in-memory buffer) so the
        // summary is correct even when the session was rehydrated after a restart.
        const [messages, events] = await Promise.all([
            this.readJsonl("raw/messages.jsonl"),
            this.readJsonl("raw/events.jsonl")
        ]);
        const sessionEvents = [...messages, ...events]
            .filter((entry) => entry.sessionId === session.id)
            .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
        const lines = [
            `# Session ${session.id}`,
            "",
            `Client: ${session.client}`,
            `Started: ${session.startedAt}`,
            `Ended: ${session.endedAt ?? ""}`,
            "",
            "## Events",
            ...sessionEvents.map((entry) => `- [${entry.type ?? "event"}] ${entry.content ?? ""}`)
        ];
        await writeFile(join(this.memoryDir, "sessions", `${session.id}.md`), `${lines.join("\n")}\n`, "utf8");
    }
    async readBrainFile(filename) {
        return readFile(join(this.memoryDir, "brain", filename), "utf8");
    }
    async applyStructuredMemory(memory, source, modelEntities) {
        const modelEntitiesFor = (content) => modelEntities?.get(content.trim()) ?? [];
        const existing = await this.readMemoryRecords();
        const existingByKey = new Map(existing.map((record) => [memoryKey(record.type, record.content), record]));
        const byId = new Map(existing.map((record) => [record.id, record]));
        const now = new Date().toISOString();
        let superseded = 0;
        let obsoleted = 0;
        let added = 0;
        // Reconciliation pre-pass: apply supersede/obsolete operations against existing
        // records BEFORE the add loop. A supersede flips the old record to "superseded"
        // and pushes its replacement onto the add channel, so the new belief flows
        // through the same upsert path (no duplicate add code). Operations are already
        // validated by parseProcessedMemory; here we guard existence, idempotency, and
        // self-supersession, and silently drop anything unresolved (never throw).
        const additions = [...processedMemoryToRecords(memory)];
        for (const operation of memory.operations ?? []) {
            const target = byId.get(operation.targetId);
            if (!target)
                continue; // unknown / hallucinated id → drop (degrade to add-only)
            if (target.status === "superseded")
                continue; // idempotency: already settled
            if (operation.op === "obsolete") {
                target.status = "superseded";
                target.supersededBy = undefined;
                target.updatedAt = now;
                obsoleted += 1;
                continue;
            }
            // op === "supersede"
            const replacement = operation.replacement;
            if (!replacement || typeof replacement.content !== "string" || !replacement.content.trim())
                continue;
            const replacementId = stableMemoryId(replacement.type, replacement.content);
            if (replacementId === target.id)
                continue; // self-supersede → no-op
            target.status = "superseded";
            target.supersededBy = replacementId;
            target.updatedAt = now;
            superseded += 1;
            additions.push(replacement);
        }
        for (const input of additions) {
            const key = memoryKey(input.type, input.content);
            const current = existingByKey.get(key);
            if (current) {
                current.updatedAt = now;
                current.score = mergeScore(current.score, scoreMemory(input));
                current.entities = unique([...current.entities, ...inferEntities(input.content, [...(input.entities ?? []), ...modelEntitiesFor(input.content)])]);
                // Re-affirmation revives a retired belief: an explicit re-add of content
                // that was previously superseded/stale/conflicted means it is current
                // again, so bring it back to active and drop any stale supersede link.
                if (current.status !== "active") {
                    current.status = "active";
                    current.supersededBy = undefined;
                }
                existingByKey.set(key, current);
                continue;
            }
            const score = scoreMemory(input);
            existingByKey.set(key, {
                id: stableMemoryId(input.type, input.content),
                type: input.type,
                content: input.content.trim(),
                normalized: normalizeMemory(input.content),
                scope: input.scope ?? "project",
                status: input.status ?? "active",
                score,
                source: {
                    kind: "ai_processing",
                    reason: source.reason
                },
                entities: inferEntities(input.content, [...(input.entities ?? []), ...modelEntitiesFor(input.content)]),
                provenance: deriveProvenance(input.content, now),
                createdAt: now,
                updatedAt: now
            });
            added += 1;
        }
        const records = Array.from(existingByKey.values()).sort((left, right) => left.type === right.type ? left.content.localeCompare(right.content) : left.type.localeCompare(right.type));
        await this.replaceMemoryRecords(records);
        return { superseded, obsoleted, added };
    }
    async readMemoryRecords() {
        return (await this.readJsonl("brain/memories.jsonl")).flatMap((value) => {
            if (isMemoryRecord(value))
                return [value];
            return [];
        });
    }
    async readMemoryGraph() {
        const raw = await readFile(join(this.memoryDir, "brain", "graph.json"), "utf8").catch(() => "");
        if (!raw.trim())
            return emptyGraph();
        try {
            return JSON.parse(raw);
        }
        catch {
            return emptyGraph();
        }
    }
    async appendJsonl(relativePath, value) {
        await this.appendMarkdown(relativePath, `${JSON.stringify(value)}\n`);
    }
    async appendMarkdown(relativePath, content) {
        await appendFile(join(this.memoryDir, relativePath), content, "utf8");
    }
    async appendList(relativePath, items) {
        if (items.length === 0)
            return;
        await this.appendMarkdown(relativePath, items.map((item) => `- ${item}`).join("\n") + "\n");
    }
    async readJsonl(relativePath) {
        const raw = await readFile(join(this.memoryDir, relativePath), "utf8").catch(() => "");
        return raw
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .flatMap((line) => {
            try {
                return [JSON.parse(line)];
            }
            catch {
                return [];
            }
        });
    }
}
function normalizeContextBudget(maxChars) {
    if (maxChars === undefined || !Number.isFinite(maxChars))
        return 24000;
    return Math.min(Math.max(Math.floor(maxChars), 4000), 50000);
}
function compactMemoryText(text, options) {
    if (text.length <= options.maxChars)
        return text;
    const lines = text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .filter(isUsefulContextLine);
    const header = lines.slice(0, Math.min(6, lines.length));
    const terms = contextTerms(options.query);
    const matches = terms.length > 0
        ? lines.filter((line) => {
            const normalized = line.toLowerCase();
            return terms.some((term) => normalized.includes(term));
        })
        : [];
    const recent = lines.slice(-40);
    const selected = uniqueLines([
        ...header,
        `## Compacted ${options.title}`,
        ...(matches.length > 0 ? ["### Query Matches", ...matches.slice(-24)] : []),
        "### Recent Entries",
        ...recent
    ]);
    const compacted = selected.join("\n");
    if (compacted.length <= options.maxChars) {
        return `${compacted}\n`;
    }
    const half = Math.floor(options.maxChars * 0.45);
    return `${compacted.slice(0, half)}\n\n[...compacted...]\n\n${compacted.slice(-half)}\n`;
}
function contextTerms(query) {
    if (!query)
        return [];
    return query
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter((term) => term.length >= 3)
        .slice(0, 12);
}
function isUsefulContextLine(line) {
    return ![
        "mcp__peon__get_context",
        "mcp__peon__start_session",
        '"query":"select:mcp__peon',
        "Output: Error: result",
        "total_deferred_tools"
    ].some((needle) => line.includes(needle));
}
function uniqueLines(lines) {
    const seen = new Set();
    return lines.filter((line) => {
        if (seen.has(line))
            return false;
        seen.add(line);
        return true;
    });
}
function processedMemoryToRecords(memory) {
    return [
        ...(memory.summary.trim() ? [{ type: "summary", content: memory.summary }] : []),
        ...memory.decisions.map((content) => ({ type: "decision", content })),
        ...memory.preferences.map((content) => ({ type: "preference", content })),
        ...memory.openQuestions.map((content) => ({ type: "open_question", content })),
        ...memory.artifacts.map((content) => ({ type: "artifact", content })),
        ...memory.timeline.map((content) => ({ type: "timeline", content })),
        ...(memory.memories ?? [])
    ].filter((record) => record.content.trim().length > 0);
}
/**
 * Render a query-ranked slice of beliefs into a compact, titled section that fits `maxChars`.
 * Used to build query-FOCUSED context sections (one per belief type) instead of dumping whole
 * brain .md files. Emits content-only bullets (no importance/confidence noise) to save tokens;
 * stops as soon as the next bullet would exceed the budget. Empty input → empty string, so an
 * irrelevant section drops out of the injection entirely.
 */
function formatContextRecords(ranked, maxChars, title) {
    if (ranked.length === 0 || maxChars <= 0)
        return "";
    const header = `# ${title}\n`;
    let out = header;
    for (const { record } of ranked) {
        const line = `- ${record.content}\n`;
        if (out.length + line.length > maxChars)
            break;
        out += line;
    }
    return out === header ? "" : out;
}
/**
 * Format top episodes as WHOLE turns up to a char budget (truncating only the last). Unlike the
 * belief sections we deliberately do NOT run compactMemoryText here — episodes are verbatim
 * answers (e.g. "the professor's 3 ideas"); fragmenting them defeats the purpose. Better to show
 * a few complete turns than slivers of many.
 */
function formatEpisodes(ranked, maxChars) {
    if (ranked.length === 0 || maxChars <= 0)
        return "";
    let out = "# Episodic Recall\n";
    for (const { record } of ranked) {
        if (out.length >= maxChars)
            break;
        const remaining = maxChars - out.length;
        const body = record.content.length > remaining ? `${record.content.slice(0, remaining - 1)}…` : record.content;
        out += `- [${record.createdAt}] ${body}\n`;
    }
    return out === "# Episodic Recall\n" ? "" : out;
}
function formatRankedMemoryRecords(ranked) {
    if (ranked.length === 0)
        return "";
    return [
        "# Structured Memory",
        ...ranked.map(({ record }) => {
            const score = `importance=${record.score.importance.toFixed(2)} confidence=${record.score.confidence.toFixed(2)}`;
            const entities = record.entities.length > 0 ? ` entities=${record.entities.join(",")}` : "";
            return `- [${record.type}] ${record.content} (${score} status=${record.status}${entities})`;
        })
    ].join("\n") + "\n";
}
function formatInjectionPreview(context) {
    return [
        "Peon Relevant Memory",
        context.summary.trim(),
        context.memories.trim(),
        context.decisions.trim(),
        context.preferences.trim(),
        context.openQuestions.trim(),
        context.artifacts.trim(),
        context.timeline.trim()
    ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 6000);
}
function recordStrength(record) {
    return record.score.importance + record.score.confidence;
}
function scoreMemory(input) {
    const baseImportance = {
        summary: 0.75,
        decision: 0.9,
        preference: 0.75,
        open_question: 0.65,
        artifact: 0.8,
        timeline: 0.55,
        fact: 0.7
    };
    return {
        importance: clamp(input.importance ?? baseImportance[input.type] ?? 0.6),
        confidence: clamp(input.confidence ?? 0.82)
    };
}
function mergeScore(left, right) {
    return {
        importance: clamp(Math.max(left.importance, right.importance)),
        confidence: clamp(Math.max(left.confidence, right.confidence))
    };
}
function clamp(value) {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
function memoryKey(type, content) {
    return `${type}:${normalizeMemory(content)}`;
}
function normalizeMemory(content) {
    return content
        .toLowerCase()
        .replace(/[`"'.,;:!?()[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function stableMemoryId(type, content) {
    return `mem_${type}_${fnv1a(memoryKey(type, content))}`;
}
/**
 * The id a record gets for a given (type, content) — content-derived and stable.
 * Exported so a supersede operation's `targetId` can be computed deterministically
 * (e.g. in tests) without first reading the record back.
 */
export function memoryRecordId(type, content) {
    return stableMemoryId(type, content);
}
function nodeId(type, label) {
    return `node_${type}_${fnv1a(`${type}:${normalizeMemory(label)}`)}`;
}
function fnv1a(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
/** Canonical entities mentioned in content (deterministic resolver — see entities.ts). */
function inferEntities(content, extra = []) {
    return inferCanonicalEntities(content, extra);
}
/**
 * Source pointer for a belief so the agent can fetch GROUND TRUTH for exact specifics
 * (the "professor's email" lesson — beliefs are a lossy gist; the source has the detail).
 * Prefers an explicit external ref in the content (URL > file), else falls back to the
 * episodic time anchor (query the raw layer around capturedAt for the verbatim turns).
 */
function deriveProvenance(content, capturedAt) {
    const url = content.match(/https?:\/\/[^\s)]+/);
    if (url)
        return { kind: "url", ref: url[0], capturedAt };
    const file = content.match(/[\w./-]+\.(?:ts|tsx|js|jsx|py|md|json|ipynb|pdf|sql|sh|yaml|yml)\b/);
    if (file) {
        // Canonicalize so the ref isn't a phantom ("2/peon-mcp/...") or an absolute path.
        const canonical = canonicalizeEntity(file[0]);
        if (canonical)
            return { kind: "file", ref: canonical.key, capturedAt };
    }
    return { kind: "episodic", ref: capturedAt, capturedAt };
}
function buildMemoryGraph(projectName, records) {
    const projectNode = { id: nodeId("project", projectName), type: "project", label: projectName };
    const nodes = new Map([[projectNode.id, projectNode]]);
    const edges = new Map();
    // Canonical entity registry: collapses alias forms (daemon.ts → src/daemon.ts) and tags
    // each entity's namespace so one file is ONE node and traversal can weight code vs domain.
    const { canonical } = buildEntityRegistry(records.flatMap((record) => record.entities));
    const registryNamespace = new Map();
    for (const record of records) {
        for (const raw of record.entities) {
            const c = canonicalizeEntity(raw);
            if (c)
                registryNamespace.set(canonical.get(raw) ?? c.key, c.namespace);
        }
    }
    for (const record of records) {
        const memoryNode = { id: nodeId(record.type, record.content), type: record.type, label: record.content };
        nodes.set(memoryNode.id, memoryNode);
        const projectEdgeType = record.type === "artifact" ? "produced" : "contains";
        edges.set(`${projectNode.id}:${memoryNode.id}:${projectEdgeType}`, {
            from: projectNode.id,
            to: memoryNode.id,
            type: projectEdgeType
        });
        for (const raw of unique(record.entities.map((e) => canonical.get(e) ?? e))) {
            const entityNode = { id: nodeId("entity", raw), type: "entity", label: raw, namespace: registryNamespace.get(raw) ?? "code" };
            nodes.set(entityNode.id, entityNode);
            edges.set(`${memoryNode.id}:${entityNode.id}:mentions`, {
                from: memoryNode.id,
                to: entityNode.id,
                type: "mentions"
            });
        }
    }
    return {
        nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
        edges: Array.from(edges.values()).sort((left, right) => `${left.from}:${left.to}:${left.type}`.localeCompare(`${right.from}:${right.to}:${right.type}`))
    };
}
function emptyGraph() {
    return { nodes: [], edges: [] };
}
function isMemoryRecord(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return (typeof record.id === "string" &&
        typeof record.type === "string" &&
        typeof record.content === "string" &&
        typeof record.normalized === "string" &&
        typeof record.scope === "string" &&
        typeof record.status === "string" &&
        typeof record.createdAt === "string" &&
        typeof record.updatedAt === "string" &&
        typeof record.score === "object" &&
        record.score !== null);
}
function unique(values) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
