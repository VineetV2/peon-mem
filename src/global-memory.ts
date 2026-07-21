import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MemoryRecord, MemoryRecordInput, MemoryStatus, MemoryType } from "./types.js";

export interface OpenGlobalMemoryStoreOptions {
  globalDir?: string;
}

export interface ListGlobalMemoryOptions {
  query?: string;
  type?: MemoryType;
  status?: MemoryStatus;
}

export interface GlobalMemorySource {
  kind?: MemoryRecord["source"]["kind"];
  reason?: string;
}

export class PeonGlobalMemoryStore {
  private static readonly defaultGlobalDir = join(homedir(), "Library", "Application Support", "Peon", "global");

  private constructor(private readonly globalDir: string) {}

  static defaultDirectory(): string {
    return PeonGlobalMemoryStore.defaultGlobalDir;
  }

  static async open(options: OpenGlobalMemoryStoreOptions = {}): Promise<PeonGlobalMemoryStore> {
    const store = new PeonGlobalMemoryStore(options.globalDir ?? PeonGlobalMemoryStore.defaultDirectory());
    await store.ensureLayout();
    return store;
  }

  async append(input: MemoryRecordInput, source: GlobalMemorySource = {}): Promise<MemoryRecord> {
    const record = createRecord(input, source, { stableId: false });
    await appendFile(this.recordsPath(), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async upsert(input: MemoryRecordInput, source: GlobalMemorySource = {}): Promise<MemoryRecord> {
    const records = await this.readRecords();
    const key = memoryKey(input.type, input.content);
    const existingIndex = records.findIndex((record) => memoryKey(record.type, record.content) === key);

    if (existingIndex === -1) {
      const record = createRecord(input, source, { stableId: true });
      records.push(record);
      await this.writeRecords(records);
      return record;
    }

    const existing = records[existingIndex];
    const updated = mergeRecord(existing, input, source);
    records[existingIndex] = updated;
    await this.writeRecords(records);
    return updated;
  }

  async list(options: ListGlobalMemoryOptions = {}): Promise<MemoryRecord[]> {
    const terms = searchTerms(options.query);
    return (await this.readRecords())
      .filter((record) => record.scope === "global")
      .filter((record) => (options.type ? record.type === options.type : true))
      .filter((record) => (options.status ? record.status === options.status : true))
      .map((record) => ({ record, relevance: memoryRelevance(record, terms) }))
      .filter(({ relevance }) => terms.length === 0 || relevance > 0)
      .sort((left, right) => compareRankedRecords(left, right))
      .map(({ record }) => record);
  }

  async search(query: string, options: Omit<ListGlobalMemoryOptions, "query"> = {}): Promise<MemoryRecord[]> {
    return this.list({ ...options, query });
  }

  /**
   * Curate the GLOBAL brain itself: resolve conflicts and merge duplicates across
   * the shared cross-project memory (global beliefs are the working set here, so
   * they are NOT treated as protected). Snapshots a backup first. LLM compression
   * is opt-in via the summarizer. Returns the actions taken.
   */
  async runBrainPass(options: { summarize?: import("./brain.js").Summarizer } = {}): Promise<import("./brain.js").BrainAction[]> {
    const { runSleepCycle } = await import("./brain.js");
    const all = await this.readRecords();
    if (all.length === 0) return [];
    const now = new Date().toISOString();
    await this.snapshotBackup(all);
    const { records, actions } = await runSleepCycle(all, {
      now,
      summarize: options.summarize,
      protectGlobalScope: false,
      makeSummaryId: (entity) => stableMemoryId("summary", `global:${entity}`)
    });
    if (actions.length === 0) return [];
    await this.writeRecords(records);
    await appendFile(join(this.globalDir, "brain-actions.jsonl"), `${JSON.stringify({ at: now, actions })}\n`, "utf8");
    return actions;
  }

  async readBrainActions(limit = 50): Promise<Array<{ at: string; actions: import("./brain.js").BrainAction[] }>> {
    const raw = await readFile(join(this.globalDir, "brain-actions.jsonl"), "utf8").catch(() => "");
    const rows = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    return rows.slice(-limit).reverse();
  }

  private async snapshotBackup(records: MemoryRecord[]): Promise<void> {
    const dir = join(this.globalDir, "backups");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(dir, `memories-${stamp}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }

  async importGlobalRecords(records: MemoryRecord[], source: GlobalMemorySource = {}): Promise<MemoryRecord[]> {
    const imported: MemoryRecord[] = [];
    for (const record of records) {
      if (record.scope !== "global") continue;
      imported.push(await this.upsert(memoryRecordToInput(record), {
        kind: source.kind ?? record.source.kind,
        reason: source.reason ?? record.source.reason
      }));
    }
    return imported;
  }

  private async ensureLayout(): Promise<void> {
    await mkdir(this.globalDir, { recursive: true });
    await readFile(this.recordsPath(), "utf8").catch(async () => {
      await writeFile(this.recordsPath(), "", "utf8");
    });
  }

  private recordsPath(): string {
    return join(this.globalDir, "memories.jsonl");
  }

  private async readRecords(): Promise<MemoryRecord[]> {
    const raw = await readFile(this.recordsPath(), "utf8").catch(() => "");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return isMemoryRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  }

  private async writeRecords(records: MemoryRecord[]): Promise<void> {
    await writeFile(
      this.recordsPath(),
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
      "utf8"
    );
  }
}

function createRecord(
  input: MemoryRecordInput,
  source: GlobalMemorySource,
  options: { stableId: boolean }
): MemoryRecord {
  const now = new Date().toISOString();
  const content = input.content.trim();
  return {
    id: options.stableId ? stableMemoryId(input.type, content) : `global_${randomUUID()}`,
    type: input.type,
    content,
    normalized: normalizeMemory(content),
    scope: "global",
    status: input.status ?? "active",
    score: scoreMemory(input),
    source: {
      kind: source.kind ?? "manual",
      reason: source.reason
    },
    entities: unique(input.entities ?? []),
    createdAt: now,
    updatedAt: now
  };
}

function mergeRecord(
  existing: MemoryRecord,
  input: MemoryRecordInput,
  source: GlobalMemorySource
): MemoryRecord {
  const score = scoreMemory(input);
  return {
    ...existing,
    type: input.type,
    content: input.content.trim(),
    normalized: normalizeMemory(input.content),
    scope: "global",
    status: input.status ?? existing.status,
    score: {
      importance: Math.max(existing.score.importance, score.importance),
      confidence: Math.max(existing.score.confidence, score.confidence)
    },
    source: {
      kind: source.kind ?? existing.source.kind,
      reason: source.reason ?? existing.source.reason
    },
    entities: unique([...existing.entities, ...(input.entities ?? [])]),
    updatedAt: new Date().toISOString()
  };
}

function memoryRecordToInput(record: MemoryRecord): MemoryRecordInput {
  return {
    type: record.type,
    content: record.content,
    scope: record.scope,
    importance: record.score.importance,
    confidence: record.score.confidence,
    entities: record.entities,
    status: record.status
  };
}

function scoreMemory(input: MemoryRecordInput): MemoryRecord["score"] {
  const baseImportance: Record<MemoryType, number> = {
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

function compareRankedRecords(
  left: { record: MemoryRecord; relevance: number },
  right: { record: MemoryRecord; relevance: number }
): number {
  if (left.relevance !== right.relevance) return right.relevance - left.relevance;
  const statusRank = statusWeight(right.record.status) - statusWeight(left.record.status);
  if (statusRank !== 0) return statusRank;
  const leftScore = left.record.score.importance + left.record.score.confidence;
  const rightScore = right.record.score.importance + right.record.score.confidence;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return right.record.updatedAt.localeCompare(left.record.updatedAt);
}

function statusWeight(status: MemoryStatus): number {
  if (status === "active") return 2;
  if (status === "conflicted") return 1;
  return 0;
}

function memoryRelevance(record: MemoryRecord, terms: string[]): number {
  if (terms.length === 0) return 1;
  const haystack = `${record.type} ${record.content} ${record.entities.join(" ")}`.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

function searchTerms(query: string | undefined): string[] {
  if (!query) return [];
  return unique(
    query
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((term) => term.length >= 2)
      .slice(0, 16)
  );
}

function memoryKey(type: MemoryType, content: string): string {
  return `${type}:${normalizeMemory(content)}`;
}

function normalizeMemory(content: string): string {
  return content
    .toLowerCase()
    .replace(/[`"'.,;:!?()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stableMemoryId(type: MemoryType, content: string): string {
  return `global_${type}_${fnv1a(memoryKey(type, content))}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function unique<T>(items: T[]): T[] {
  const seen = new Set<T>();
  return items.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<MemoryRecord>;
  return (
    typeof record.id === "string" &&
    isMemoryType(record.type) &&
    typeof record.content === "string" &&
    typeof record.normalized === "string" &&
    record.scope === "global" &&
    isMemoryStatus(record.status) &&
    typeof record.score?.importance === "number" &&
    typeof record.score.confidence === "number" &&
    isMemorySource(record.source) &&
    Array.isArray(record.entities) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isMemoryType(value: unknown): value is MemoryType {
  return (
    value === "summary" ||
    value === "decision" ||
    value === "preference" ||
    value === "open_question" ||
    value === "artifact" ||
    value === "timeline" ||
    value === "fact"
  );
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return value === "active" || value === "stale" || value === "conflicted" || value === "superseded" || value === "archived";
}

function isMemorySource(value: unknown): value is MemoryRecord["source"] {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<MemoryRecord["source"]>;
  return source.kind === "ai_processing" || source.kind === "manual" || source.kind === "hook";
}
