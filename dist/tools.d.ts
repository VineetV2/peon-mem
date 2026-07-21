import { type MaybeProcessMemoryResult, type ProcessMemoryResult } from "./processor.js";
import { selectMemoryRecordsForContext, type RankedMemoryRecord } from "./retrieval.js";
import { type MemoryQualityReport } from "./quality.js";
import { type GlobalMemorySource } from "./global-memory.js";
import type { BrainAction } from "./brain.js";
import { type EvaluationReport, type ExpectedMemoryInput } from "./evaluation.js";
import { type ContextInjection } from "./injection.js";
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
    topEntities: Array<{
        entity: string;
        count: number;
    }>;
    recentActions: BrainActivityItem[];
    records: Array<{
        id: string;
        type: string;
        content: string;
        entities: string[];
    }>;
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
    extractGlobal(input: {
        projectPath: string;
    }): Promise<{
        promoted: MemoryRecord[];
    }>;
    recurateProject(input: {
        projectPath: string;
    }): Promise<{
        archived: number;
        considered: number;
        capped?: boolean;
    }>;
    brainPass(input: {
        projectPath: string;
        recalledIds?: string[];
        compress?: boolean;
    }): Promise<{
        actions: BrainAction[];
    }>;
    globalBrainPass(input: {
        compress?: boolean;
    }): Promise<{
        actions: BrainAction[];
    }>;
    brainActivity(input: {
        projectPaths: string[];
        limit?: number;
    }): Promise<BrainActivityItem[]>;
    globalDashboard(): Promise<GlobalDashboard>;
    brainActions(input: {
        projectPath: string;
        limit?: number;
    }): Promise<Array<{
        at: string;
        actions: BrainAction[];
    }>>;
    restoreBackup(input: {
        projectPath: string;
    }): Promise<{
        restored: boolean;
    }>;
    updateMemory(input: UpdateMemoryToolInput): Promise<MemoryRecord | null>;
    deleteMemory(input: DeleteMemoryToolInput): Promise<{
        deleted: boolean;
    }>;
    mergeMemory(input: MergeMemoryToolInput): Promise<MemoryRecord | null>;
    evaluateProject(input: EvaluateProjectToolInput): Promise<EvaluationReport>;
    buildInjection(input: BuildInjectionToolInput): Promise<ContextInjection>;
    crossProjectSearch(input: CrossProjectSearchToolInput): Promise<CrossProjectSearchToolResult>;
    processMemory(input: ProcessMemoryToolInput): Promise<ProcessMemoryResult>;
    maybeProcessMemory(input: MaybeProcessMemoryToolInput): Promise<MaybeProcessMemoryResult>;
}
export declare function createPeonTools(options?: CreatePeonToolsOptions): PeonTools;
