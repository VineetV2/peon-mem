export type PeonRole = "user" | "assistant" | "system";

export interface PeonSession {
  id: string;
  projectPath: string;
  client: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
}

export interface PeonEvent {
  id: string;
  sessionId: string;
  type: string;
  content: string;
  createdAt: string;
  role?: PeonRole;
}

export interface ProjectContext {
  summary: string;
  memories: string;
  decisions: string;
  preferences: string;
  openQuestions: string;
  artifacts: string;
  timeline: string;
  /** Episodic recall: top raw conversational turns relevant to the query (when requested). */
  episodes?: string;
  meta?: {
    compacted: boolean;
    maxChars: number;
  };
  /** Ids of the active beliefs that were actually recalled for this query — feeds reinforcement. */
  recalledIds?: string[];
  /**
   * The single most query-relevant belief, hoisted so the injection can LEAD with it as a
   * prominent banner — a structural nudge against the agent re-deriving what's already known.
   * Only set when there's a query and a genuine (non-graph-neighbour) top hit.
   */
  headline?: string;
  /**
   * HIERARCHICAL RECALL: top query-relevant beliefs from Peon's GLOBAL brain (the parent of
   * every project brain) — user-level facts/preferences every project should inherit.
   */
  global?: string;
}

export interface ProcessedMemory {
  summary: string;
  decisions: string[];
  preferences: string[];
  openQuestions: string[];
  artifacts: string[];
  timeline: string[];
  memories?: MemoryRecordInput[];
  /**
   * Integrative consolidation operations. The model (or a manual aiResult)
   * emits these AFTER seeing existing durable memory, to reconcile beliefs that
   * changed — rather than only adding net-new facts. Absent/empty => add-only.
   */
  operations?: ConsolidationOperation[];
}

/**
 * A reconciliation operation against an EXISTING memory record (by id).
 * Only two verbs — net-new beliefs flow through the add channels, and an
 * in-place edit is expressed as supersede(old) + replacement(new).
 */
export type ConsolidationOperation =
  | { op: "supersede"; targetId: string; reason?: string; replacement: MemoryRecordInput }
  | { op: "obsolete"; targetId: string; reason?: string };

export interface ProcessingState {
  lastStatus?: "processed" | "skipped" | "failed";
  lastTrigger?: string;
  lastReason?: string;
  lastProcessedAt?: string;
  lastProcessedRawChars?: number;
  lastRawChars?: number;
  /** Id of the last raw event consolidated — the delta cursor for the prompt. */
  lastProcessedEventId?: string;
  lastModel?: string;
  lastEstimatedTokens?: number;
  lastSkippedAt?: string;
  lastSkipReason?: string;
  /** Observability: what the most recent consolidation actually did. */
  lastOperationsEmitted?: number;
  lastSuperseded?: number;
  lastObsoleted?: number;
  lastMerged?: number;
}

export type MemoryType = "summary" | "decision" | "preference" | "open_question" | "artifact" | "timeline" | "fact";
export type MemoryScope = "project" | "global" | "session";
export type MemoryStatus = "active" | "stale" | "conflicted" | "superseded" | "archived";

export interface MemoryRecordInput {
  type: MemoryType;
  content: string;
  scope?: MemoryScope;
  importance?: number;
  confidence?: number;
  entities?: string[];
  status?: MemoryStatus;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  normalized: string;
  scope: MemoryScope;
  status: MemoryStatus;
  score: {
    importance: number;
    confidence: number;
  };
  source: {
    kind: "ai_processing" | "manual" | "hook";
    reason?: string;
  };
  entities: string[];
  createdAt: string;
  updatedAt: string;
  /** When status === "superseded", the id of the record that replaced this one. */
  supersededBy?: string;
  /** User-pinned beliefs are protected from auto-staleness and rank first. */
  pinned?: boolean;
  /** Reinforcement: how "alive" this belief is. Recall raises it, disuse lets it settle.
   *  Drives what stays in working memory vs what gets compressed. Defaults to importance. */
  strength?: number;
  /** Times this belief has been recalled (injected or matched). */
  recallCount?: number;
  /** ISO timestamp of the last recall. */
  lastRecalledAt?: string;
  /** On a SUMMARY belief: the ids of the raw beliefs it rolls up (now archived). */
  summaryOf?: string[];
  /** On a raw belief: the id of the summary that now represents it (status archived). */
  summarizedBy?: string;
  /** Where this belief came from, so the agent can fetch ground truth for exact specifics. */
  provenance?: {
    kind: "url" | "file" | "episodic";
    /** The pointer: a URL, a file path, or the ISO time anchor for the episodic layer. */
    ref: string;
    capturedAt: string;
  };
}

export interface MemoryGraph {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    /** For entity nodes: "code" (files/symbols) or "domain" (people/papers/concepts). */
    namespace?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
  }>;
}

export interface BrainInspection {
  projectPath: string;
  query?: string;
  records: MemoryRecord[];
  graph: MemoryGraph;
  injectionPreview: string;
  context: ProjectContext;
}
