import { basename } from "node:path";
import { loadPeonConfig } from "./config.js";
import { createEmbeddingClient } from "./embeddings.js";
import { PeonMemoryStore } from "./memory-store.js";
import { PeonMemoryProcessor, type MaybeProcessMemoryResult, type ProcessMemoryResult } from "./processor.js";
import { selectMemoryRecordsForContext, type RankedMemoryRecord } from "./retrieval.js";
import { createQualityReport, type MemoryQualityReport } from "./quality.js";
import { PeonGlobalMemoryStore, type GlobalMemorySource } from "./global-memory.js";
import { redactSecrets } from "./injection.js";
import { selectGloballyPromotable } from "./global-promotion.js";
import type { BrainAction } from "./brain.js";
import { createClusterSummarizer } from "./compression.js";
import { createGlobalExtractor } from "./global-extraction.js";
import { createRecurator } from "./recuration.js";
import { evaluatePeonProject, type EvaluationReport, type ExpectedMemoryInput } from "./evaluation.js";
import { buildContextInjection, type ContextInjection } from "./injection.js";
import { SessionIndex } from "./session-index.js";
import type { BrainInspection, MemoryRecord, MemoryRecordInput, MemoryStatus, MemoryType, PeonEvent, PeonRole, PeonSession, ProcessedMemory, ProjectContext } from "./types.js";

export interface CreatePeonToolsOptions {
  daemonUrl?: string;
  globalMemoryDir?: string;
  /** Path to the durable sessionId → project index. Defaults to the global Peon dir. */
  sessionIndexPath?: string;
}

export interface StartSessionToolInput {
  projectPath: string;
  client: string;
  cwd?: string;
}

export interface StartSessionToolResult {
  sessionId: string;
  projectPath: string;
}

export interface RecordMessageToolInput {
  sessionId: string;
  role: PeonRole;
  content: string;
}

export interface RecordEventToolInput {
  sessionId: string;
  type: string;
  content: string;
}

export interface EndSessionToolInput {
  sessionId: string;
}

export interface GetContextToolInput {
  projectPath: string;
  query?: string;
  maxChars?: number;
}

export interface InspectBrainToolInput {
  projectPath: string;
  query?: string;
  maxChars?: number;
}

export interface ProcessMemoryToolInput {
  projectPath: string;
  reason?: string;
  aiResult?: ProcessedMemory;
}

export interface MaybeProcessMemoryToolInput {
  projectPath: string;
  trigger: string;
  force?: boolean;
  aiResult?: ProcessedMemory;
}

export interface SearchMemoryToolInput {
  projectPath: string;
  query: string;
  limit?: number;
  maxChars?: number;
}

export interface SearchMemoryToolResult {
  projectPath: string;
  query: string;
  records: RankedMemoryRecord[];
  selected: ReturnType<typeof selectMemoryRecordsForContext>;
  injectionPreview: string;
}

export interface QualityReportToolInput {
  projectPath: string;
  staleAfterDays?: number;
}

export interface GlobalMemoryToolInput {
  memory: MemoryRecordInput;
  source?: GlobalMemorySource;
}

export interface SearchGlobalMemoryToolInput {
  query?: string;
  type?: MemoryType;
  status?: MemoryStatus;
}

export interface ImportGlobalMemoryToolInput {
  projectPath: string;
}

export interface PromoteToGlobalToolInput {
  projectPath: string;
}

export interface BrainActivityItem {
  at: string;
  scope: "project" | "global";
  projectName: string;
  type: string;
  detail: string;
}

export interface GlobalDashboard {
  totalBeliefs: number;
  byType: Record<string, number>;
  topEntities: Array<{ entity: string; count: number }>;
  recentActions: BrainActivityItem[];
  records: Array<{ id: string; type: string; content: string; entities: string[] }>;
}

export interface PromoteToGlobalToolResult {
  projectPath: string;
  promoted: MemoryRecord[];
}

export interface UpdateMemoryToolInput {
  projectPath: string;
  id: string;
  content?: string;
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  pinned?: boolean;
}

export interface DeleteMemoryToolInput {
  projectPath: string;
  id: string;
}

export interface MergeMemoryToolInput {
  projectPath: string;
  keepId: string;
  dropId: string;
}

export interface EvaluateProjectToolInput {
  projectPath: string;
  expectedMemories?: Array<string | ExpectedMemoryInput>;
}

export interface BuildInjectionToolInput {
  projectPath: string;
  query?: string;
  maxChars?: number;
  includeInactive?: boolean;
}

export interface CrossProjectSearchToolInput {
  query: string;
  /** Projects to search. When omitted, the daemon fills this with all known projects. */
  projectPaths?: string[];
  /** Usually the current project — excluded so you only get OTHER projects' beliefs. */
  excludeProjectPath?: string;
  limit?: number;
  perProjectLimit?: number;
  /** Cap on how many projects to FULLY (semantically) rank after the cheap pre-filter. */
  maxProjects?: number;
}

export interface CrossProjectHit {
  projectPath: string;
  projectName: string;
  record: MemoryRecord;
  score: number;
  explanation: string;
}

export interface CrossProjectSearchToolResult {
  query: string;
  projectsSearched: string[];
  results: CrossProjectHit[];
}

export interface PeonTools {
  startSession(input: StartSessionToolInput): Promise<StartSessionToolResult>;
  recordMessage(input: RecordMessageToolInput): Promise<PeonEvent>;
  recordEvent(input: RecordEventToolInput): Promise<PeonEvent>;
  endSession(input: EndSessionToolInput): Promise<PeonSession>;
  getContext(input: GetContextToolInput): Promise<ProjectContext>;
  inspectBrain(input: InspectBrainToolInput): Promise<BrainInspection>;
  searchMemory(input: SearchMemoryToolInput): Promise<SearchMemoryToolResult>;
  qualityReport(input: QualityReportToolInput): Promise<MemoryQualityReport>;
  rememberGlobal(input: GlobalMemoryToolInput): Promise<MemoryRecord>;
  searchGlobalMemory(input: SearchGlobalMemoryToolInput): Promise<MemoryRecord[]>;
  importGlobalMemory(input: ImportGlobalMemoryToolInput): Promise<MemoryRecord[]>;
  promoteToGlobal(input: PromoteToGlobalToolInput): Promise<PromoteToGlobalToolResult>;
  extractGlobal(input: { projectPath: string }): Promise<{ promoted: MemoryRecord[] }>;
  recurateProject(input: { projectPath: string }): Promise<{ archived: number; considered: number; capped?: boolean }>;
  brainPass(input: { projectPath: string; recalledIds?: string[]; compress?: boolean }): Promise<{ actions: BrainAction[] }>;
  globalBrainPass(input: { compress?: boolean }): Promise<{ actions: BrainAction[] }>;
  brainActivity(input: { projectPaths: string[]; limit?: number }): Promise<BrainActivityItem[]>;
  globalDashboard(): Promise<GlobalDashboard>;
  brainActions(input: { projectPath: string; limit?: number }): Promise<Array<{ at: string; actions: BrainAction[] }>>;
  restoreBackup(input: { projectPath: string }): Promise<{ restored: boolean }>;
  updateMemory(input: UpdateMemoryToolInput): Promise<MemoryRecord | null>;
  deleteMemory(input: DeleteMemoryToolInput): Promise<{ deleted: boolean }>;
  mergeMemory(input: MergeMemoryToolInput): Promise<MemoryRecord | null>;
  evaluateProject(input: EvaluateProjectToolInput): Promise<EvaluationReport>;
  buildInjection(input: BuildInjectionToolInput): Promise<ContextInjection>;
  crossProjectSearch(input: CrossProjectSearchToolInput): Promise<CrossProjectSearchToolResult>;
  processMemory(input: ProcessMemoryToolInput): Promise<ProcessMemoryResult>;
  maybeProcessMemory(input: MaybeProcessMemoryToolInput): Promise<MaybeProcessMemoryResult>;
}

export function createPeonTools(options: CreatePeonToolsOptions = {}): PeonTools {
  if (options.daemonUrl) {
    return createDaemonBackedTools(options.daemonUrl);
  }

  const storesByProject = new Map<string, PeonMemoryStore>();
  const sessionIndex = new SessionIndex(options.sessionIndexPath);
  let globalStorePromise: Promise<PeonGlobalMemoryStore> | undefined;

  async function storeFor(projectPath: string): Promise<PeonMemoryStore> {
    const existing = storesByProject.get(projectPath);
    if (existing) return existing;
    const store = await PeonMemoryStore.open({ projectPath });
    storesByProject.set(projectPath, store);
    return store;
  }

  async function storeForSession(sessionId: string): Promise<PeonMemoryStore> {
    const record = await sessionIndex.get(sessionId);
    if (!record) throw new Error(`Unknown Peon session: ${sessionId}`);
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

  async function globalStore(): Promise<PeonGlobalMemoryStore> {
    globalStorePromise ??= PeonGlobalMemoryStore.open({ globalDir: options.globalMemoryDir });
    return globalStorePromise;
  }

  return {
    async startSession(input: StartSessionToolInput): Promise<StartSessionToolResult> {
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

    async recordMessage(input: RecordMessageToolInput): Promise<PeonEvent> {
      const store = await storeForSession(input.sessionId);
      return store.recordMessage(input);
    },

    async recordEvent(input: RecordEventToolInput): Promise<PeonEvent> {
      const store = await storeForSession(input.sessionId);
      return store.recordEvent(input);
    },

    async endSession(input: EndSessionToolInput): Promise<PeonSession> {
      const store = await storeForSession(input.sessionId);
      const result = await store.endSession(input);
      await sessionIndex.remove(input.sessionId);
      return result;
    },

    async getContext(input: GetContextToolInput): Promise<ProjectContext> {
      const store = await storeFor(input.projectPath);
      const context = await store.getContext({ query: input.query, maxChars: input.maxChars });
      // HIERARCHY: the global brain is the PARENT of every project brain — recall inherits from
      // it. Append the top query-relevant global beliefs as their own section (small budget,
      // redacted like everything else). Failures degrade silently — the project context stands.
      try {
        const g = (await (await globalStore()).search(input.query ?? "")).slice(0, 4);
        if (g.length > 0) {
          context.global = redactSecrets(
            g.map((r) => "- [" + r.type + "] " + r.content).join("\n").slice(0, 1200)
          );
        }
      } catch {
        // global brain unavailable — project-only context is still valid
      }
      return context;
    },

    async inspectBrain(input: InspectBrainToolInput): Promise<BrainInspection> {
      const store = await storeFor(input.projectPath);
      return store.inspectBrain({ query: input.query, maxChars: input.maxChars });
    },

    async searchMemory(input: SearchMemoryToolInput): Promise<SearchMemoryToolResult> {
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

    async qualityReport(input: QualityReportToolInput): Promise<MemoryQualityReport> {
      const store = await storeFor(input.projectPath);
      return createQualityReport(await store.listMemoryRecords(), {
        staleAfterDays: input.staleAfterDays
      });
    },

    async rememberGlobal(input: GlobalMemoryToolInput): Promise<MemoryRecord> {
      return (await globalStore()).upsert({ ...input.memory, scope: "global" }, input.source);
    },

    async searchGlobalMemory(input: SearchGlobalMemoryToolInput): Promise<MemoryRecord[]> {
      return (await globalStore()).list(input);
    },

    async importGlobalMemory(input: ImportGlobalMemoryToolInput): Promise<MemoryRecord[]> {
      const store = await storeFor(input.projectPath);
      return (await globalStore()).importGlobalRecords(await store.listMemoryRecords(), {
        reason: `project-import:${input.projectPath}`
      });
    },

    async promoteToGlobal(input: PromoteToGlobalToolInput): Promise<PromoteToGlobalToolResult> {
      const store = await storeFor(input.projectPath);
      const promotable = selectGloballyPromotable(await store.listMemoryRecords());
      const global = await globalStore();
      const promoted: MemoryRecord[] = [];
      for (const record of promotable) {
        promoted.push(
          await global.upsert(
            {
              type: record.type,
              content: record.content,
              scope: "global",
              importance: record.score.importance,
              confidence: record.score.confidence,
              entities: record.entities,
              status: record.status
            },
            { kind: "ai_processing", reason: `auto-promote:${input.projectPath}` }
          )
        );
      }
      return { projectPath: input.projectPath, promoted };
    },

    async extractGlobal(input: { projectPath: string }): Promise<{ promoted: MemoryRecord[] }> {
      const extractor = createGlobalExtractor(loadPeonConfig());
      if (!extractor) return { promoted: [] };
      const store = await storeFor(input.projectPath);
      const facts = await extractor(await store.listMemoryRecords());
      const global = await globalStore();
      const promoted: MemoryRecord[] = [];
      for (const content of facts) {
        promoted.push(
          await global.upsert(
            { type: "fact", content, scope: "global", importance: 0.8, confidence: 0.8 },
            { kind: "ai_processing", reason: `global-extract:${input.projectPath}` }
          )
        );
      }
      return { promoted };
    },

    async recurateProject(input: { projectPath: string }): Promise<{ archived: number; considered: number; capped?: boolean }> {
      const recurator = createRecurator(loadPeonConfig());
      const store = await storeFor(input.projectPath);
      const records = await store.listMemoryRecords();
      const considered = records.filter((r) => r.status === "active" && !r.pinned).length;
      if (!recurator || considered === 0) return { archived: 0, considered };
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

    async brainPass(input: { projectPath: string; recalledIds?: string[]; compress?: boolean }): Promise<{ actions: BrainAction[] }> {
      const store = await storeFor(input.projectPath);
      // Compression is the only LLM step — built in-process and only when asked
      // (the daemon enables it on the cost-gated consolidation path).
      const summarize = input.compress ? createClusterSummarizer(loadPeonConfig()) ?? undefined : undefined;
      return { actions: await store.runBrainPass({ recalledIds: input.recalledIds, summarize }) };
    },

    async globalBrainPass(input: { compress?: boolean }): Promise<{ actions: BrainAction[] }> {
      const summarize = input.compress ? createClusterSummarizer(loadPeonConfig()) ?? undefined : undefined;
      return { actions: await (await globalStore()).runBrainPass({ summarize }) };
    },

    async brainActivity(input: { projectPaths: string[]; limit?: number }): Promise<BrainActivityItem[]> {
      const limit = input.limit ?? 30;
      const items: BrainActivityItem[] = [];
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

    async globalDashboard(): Promise<GlobalDashboard> {
      const store = await globalStore();
      const records = await store.list({ status: "active" });
      const byType: Record<string, number> = {};
      const entityCounts = new Map<string, number>();
      for (const record of records) {
        byType[record.type] = (byType[record.type] ?? 0) + 1;
        for (const entity of record.entities) entityCounts.set(entity, (entityCounts.get(entity) ?? 0) + 1);
      }
      const topEntities = Array.from(entityCounts.entries())
        .map(([entity, count]) => ({ entity, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
      const recentActions = (await store.readBrainActions(10)).flatMap((entry) =>
        entry.actions.map((action) => ({ at: entry.at, scope: "global" as const, projectName: "global", type: action.type, detail: action.detail }))
      );
      return {
        totalBeliefs: records.length,
        byType,
        topEntities,
        recentActions,
        records: records.slice(0, 50).map((r) => ({ id: r.id, type: r.type, content: r.content, entities: r.entities }))
      };
    },

    async brainActions(input: { projectPath: string; limit?: number }): Promise<Array<{ at: string; actions: BrainAction[] }>> {
      const store = await storeFor(input.projectPath);
      return store.readBrainActions(input.limit);
    },

    async restoreBackup(input: { projectPath: string }): Promise<{ restored: boolean }> {
      const store = await storeFor(input.projectPath);
      return { restored: await store.restoreLatestBackup() };
    },

    async updateMemory(input: UpdateMemoryToolInput): Promise<MemoryRecord | null> {
      const store = await storeFor(input.projectPath);
      return store.updateMemoryRecord(input.id, {
        content: input.content,
        importance: input.importance,
        confidence: input.confidence,
        status: input.status,
        pinned: input.pinned
      });
    },

    async deleteMemory(input: DeleteMemoryToolInput): Promise<{ deleted: boolean }> {
      const store = await storeFor(input.projectPath);
      return { deleted: await store.deleteMemoryRecord(input.id) };
    },

    async mergeMemory(input: MergeMemoryToolInput): Promise<MemoryRecord | null> {
      const store = await storeFor(input.projectPath);
      return store.mergeMemoryRecords(input.keepId, input.dropId);
    },

    async evaluateProject(input: EvaluateProjectToolInput): Promise<EvaluationReport> {
      return evaluatePeonProject(input);
    },

    async buildInjection(input: BuildInjectionToolInput): Promise<ContextInjection> {
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

    async crossProjectSearch(input: CrossProjectSearchToolInput): Promise<CrossProjectSearchToolResult> {
      const targets = (input.projectPaths ?? []).filter(
        (path) => path && path !== input.excludeProjectPath
      );
      const perProjectLimit = input.perProjectLimit ?? 6;
      const maxProjects = Math.max(1, input.maxProjects ?? 25);
      const terms = queryTerms(input.query);

      // Phase 1 — cheap lexical pre-filter: read each project's records (no embeddings)
      // and keep only those that mention the query at all, ranked by hit count. This
      // avoids doing the expensive semantic pass over dozens of irrelevant projects.
      const candidates: Array<{ projectPath: string; store: PeonMemoryStore; lex: number }> = [];
      for (const projectPath of targets) {
        try {
          const store = await storeFor(projectPath);
          const active = (await store.listMemoryRecords()).filter((r) => r.status === "active");
          const lex = lexicalProjectScore(active, terms);
          // With a real query, require at least one lexical hit; with an empty query, keep all.
          if (terms.length === 0 || lex > 0) candidates.push({ projectPath, store, lex });
        } catch {
          // skip a project we cannot read
        }
      }
      candidates.sort((left, right) => right.lex - left.lex);
      const shortlist = candidates.slice(0, maxProjects);

      // Embed the query ONCE and reuse it across the shortlisted projects.
      let queryVector: number[] | undefined;
      try {
        const client = createEmbeddingClient({ config: loadPeonConfig() });
        if (client) [queryVector] = await client.embed([input.query]);
      } catch {
        // lexical-only if embeddings are unavailable
      }

      // Phase 2 — full (semantic) rank only on the shortlist.
      const hits: CrossProjectHit[] = [];
      for (const { projectPath, store } of shortlist) {
        try {
          const ranked = await store.rankRecordsReadonly(input.query, { limit: perProjectLimit, queryVector });
          for (const item of ranked) {
            if (item.record.status !== "active") continue; // current beliefs only
            hits.push({
              projectPath,
              projectName: basename(projectPath),
              record: item.record,
              score: item.score,
              explanation: item.explanation
            });
          }
        } catch {
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

    async processMemory(input: ProcessMemoryToolInput): Promise<ProcessMemoryResult> {
      const processor = new PeonMemoryProcessor();
      return processor.processMemory(input);
    },

    async maybeProcessMemory(input: MaybeProcessMemoryToolInput): Promise<MaybeProcessMemoryResult> {
      const processor = new PeonMemoryProcessor();
      return processor.maybeProcessMemory(input);
    }
  };
}

function createDaemonBackedTools(daemonUrl: string): PeonTools {
  const baseUrl = daemonUrl.replace(/\/$/, "");

  return {
    async startSession(input: StartSessionToolInput): Promise<StartSessionToolResult> {
      return postJson(`${baseUrl}/sessions`, input);
    },

    async recordMessage(input: RecordMessageToolInput): Promise<PeonEvent> {
      return postJson<PeonEvent>(`${baseUrl}/messages`, input);
    },

    async recordEvent(input: RecordEventToolInput): Promise<PeonEvent> {
      return postJson<PeonEvent>(`${baseUrl}/events`, input);
    },

    async endSession(input: EndSessionToolInput): Promise<PeonSession> {
      return postJson<PeonSession>(`${baseUrl}/sessions/${encodeURIComponent(input.sessionId)}/end`, {});
    },

    async getContext(input: GetContextToolInput): Promise<ProjectContext> {
      const url = new URL(`${baseUrl}/context`);
      url.searchParams.set("projectPath", input.projectPath);
      if (input.query) url.searchParams.set("query", input.query);
      if (input.maxChars) url.searchParams.set("maxChars", String(input.maxChars));
      const response = await fetch(url);
      return readJsonResponse<ProjectContext>(response);
    },

    async inspectBrain(input: InspectBrainToolInput): Promise<BrainInspection> {
      const url = new URL(`${baseUrl}/brain`);
      url.searchParams.set("projectPath", input.projectPath);
      if (input.query) url.searchParams.set("query", input.query);
      if (input.maxChars) url.searchParams.set("maxChars", String(input.maxChars));
      const response = await fetch(url);
      return readJsonResponse<BrainInspection>(response);
    },

    async searchMemory(input: SearchMemoryToolInput): Promise<SearchMemoryToolResult> {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("projectPath", input.projectPath);
      url.searchParams.set("query", input.query);
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      if (input.maxChars) url.searchParams.set("maxChars", String(input.maxChars));
      const response = await fetch(url);
      return readJsonResponse<SearchMemoryToolResult>(response);
    },

    async qualityReport(input: QualityReportToolInput): Promise<MemoryQualityReport> {
      const url = new URL(`${baseUrl}/quality`);
      url.searchParams.set("projectPath", input.projectPath);
      if (input.staleAfterDays) url.searchParams.set("staleAfterDays", String(input.staleAfterDays));
      const response = await fetch(url);
      return readJsonResponse<MemoryQualityReport>(response);
    },

    async rememberGlobal(input: GlobalMemoryToolInput): Promise<MemoryRecord> {
      return postJson(`${baseUrl}/global/memories`, input);
    },

    async searchGlobalMemory(input: SearchGlobalMemoryToolInput): Promise<MemoryRecord[]> {
      const url = new URL(`${baseUrl}/global/memories`);
      if (input.query) url.searchParams.set("query", input.query);
      if (input.type) url.searchParams.set("type", input.type);
      if (input.status) url.searchParams.set("status", input.status);
      const response = await fetch(url);
      return readJsonResponse<MemoryRecord[]>(response);
    },

    async importGlobalMemory(input: ImportGlobalMemoryToolInput): Promise<MemoryRecord[]> {
      return postJson(`${baseUrl}/global/import-project`, input);
    },

    async promoteToGlobal(input: PromoteToGlobalToolInput): Promise<PromoteToGlobalToolResult> {
      return postJson(`${baseUrl}/global/promote`, input);
    },

    async extractGlobal(input: { projectPath: string }): Promise<{ promoted: MemoryRecord[] }> {
      return postJson(`${baseUrl}/global/extract`, input);
    },

    async recurateProject(input: { projectPath: string }): Promise<{ archived: number; considered: number; capped?: boolean }> {
      return postJson(`${baseUrl}/recurate`, input);
    },

    async brainPass(input: { projectPath: string; recalledIds?: string[]; compress?: boolean }): Promise<{ actions: BrainAction[] }> {
      return postJson(`${baseUrl}/brain/pass`, input);
    },

    async globalBrainPass(input: { compress?: boolean }): Promise<{ actions: BrainAction[] }> {
      return postJson(`${baseUrl}/global/brain-pass`, input);
    },

    async brainActivity(input: { projectPaths: string[]; limit?: number }): Promise<BrainActivityItem[]> {
      const url = new URL(`${baseUrl}/brain/activity`);
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      return readJsonResponse(await fetch(url));
    },

    async globalDashboard(): Promise<GlobalDashboard> {
      return readJsonResponse(await fetch(`${baseUrl}/global/dashboard`));
    },

    async brainActions(input: { projectPath: string; limit?: number }): Promise<Array<{ at: string; actions: BrainAction[] }>> {
      const url = new URL(`${baseUrl}/brain/actions`);
      url.searchParams.set("projectPath", input.projectPath);
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      return readJsonResponse(await fetch(url));
    },

    async restoreBackup(input: { projectPath: string }): Promise<{ restored: boolean }> {
      return postJson(`${baseUrl}/brain/restore`, input);
    },

    async updateMemory(input: UpdateMemoryToolInput): Promise<MemoryRecord | null> {
      return postJson(`${baseUrl}/memory/update`, input);
    },

    async deleteMemory(input: DeleteMemoryToolInput): Promise<{ deleted: boolean }> {
      return postJson(`${baseUrl}/memory/delete`, input);
    },

    async mergeMemory(input: MergeMemoryToolInput): Promise<MemoryRecord | null> {
      return postJson(`${baseUrl}/memory/merge`, input);
    },

    async evaluateProject(input: EvaluateProjectToolInput): Promise<EvaluationReport> {
      return postJson(`${baseUrl}/evaluate`, input);
    },

    async buildInjection(input: BuildInjectionToolInput): Promise<ContextInjection> {
      const url = new URL(`${baseUrl}/injection`);
      url.searchParams.set("projectPath", input.projectPath);
      if (input.query) url.searchParams.set("query", input.query);
      if (input.maxChars) url.searchParams.set("maxChars", String(input.maxChars));
      if (input.includeInactive) url.searchParams.set("includeInactive", "true");
      const response = await fetch(url);
      return readJsonResponse<ContextInjection>(response);
    },

    async crossProjectSearch(input: CrossProjectSearchToolInput): Promise<CrossProjectSearchToolResult> {
      const url = new URL(`${baseUrl}/cross-context`);
      url.searchParams.set("query", input.query);
      if (input.excludeProjectPath) url.searchParams.set("exclude", input.excludeProjectPath);
      // A single explicit target maps to ?projectPath=; otherwise the daemon searches all known projects.
      if (input.projectPaths && input.projectPaths.length === 1) {
        url.searchParams.set("projectPath", input.projectPaths[0]);
      }
      if (input.limit) url.searchParams.set("limit", String(input.limit));
      if (input.maxProjects) url.searchParams.set("maxProjects", String(input.maxProjects));
      const response = await fetch(url);
      return readJsonResponse<CrossProjectSearchToolResult>(response);
    },

    async processMemory(input: ProcessMemoryToolInput): Promise<ProcessMemoryResult> {
      return postJson(`${baseUrl}/process`, input);
    },

    async maybeProcessMemory(input: MaybeProcessMemoryToolInput): Promise<MaybeProcessMemoryResult> {
      return postJson(`${baseUrl}/process/auto`, input);
    }
  };
}

function formatRankedMemoryRecord(item: RankedMemoryRecord): string {
  return `- [${item.record.type}] ${item.record.content}\n  why: ${item.explanation}\n`;
}

const CROSS_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "for", "in", "is", "of", "on", "or", "the", "to", "use", "with", "what", "did", "we", "our", "about", "from"]);

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      (query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_.\/-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1 && !CROSS_STOP_WORDS.has(t))
    )
  ];
}

/** Cheap lexical relevance for the cross-project pre-filter: how many active records mention a query term. */
function lexicalProjectScore(records: MemoryRecord[], terms: string[]): number {
  if (terms.length === 0) return records.length;
  let score = 0;
  for (const record of records) {
    const haystack = `${record.content} ${record.normalized} ${record.entities.join(" ")}`.toLowerCase();
    if (terms.some((term) => haystack.includes(term))) score += 1;
  }
  return score;
}

function formatSearchInjectionPreview(records: RankedMemoryRecord[]): string {
  if (records.length === 0) return "";
  return ["Peon Search Results", ...records.map(formatRankedMemoryRecord)].join("\n");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readJsonResponse<T>(response);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Peon daemon request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}
