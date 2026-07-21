import type { MemoryRecord, MemoryStatus } from "./types.js";

export interface DuplicateMemoryRecord {
  duplicateId: string;
  keptId: string;
  key: string;
}

export interface DeduplicateMemoryRecordsResult {
  records: MemoryRecord[];
  duplicates: DuplicateMemoryRecord[];
}

export interface MemoryConflict {
  entity: string;
  leftId: string;
  rightId: string;
  reason: string;
}

export interface StaleMemoryOptions {
  now?: Date;
  staleAfterDays?: number;
}

export interface MarkStaleMemoryRecordsResult {
  records: MemoryRecord[];
  staleIds: string[];
}

export interface PromoteMemoryRecordsOptions {
  repeatedContent?: string[];
  importantTerms?: string[];
  repeatThreshold?: number;
  repeatBoost?: number;
  importantBoost?: number;
}

export interface PromotedMemoryRecord {
  id: string;
  reason: "repeated" | "important";
  importance: number;
}

export interface PromoteMemoryRecordsResult {
  records: MemoryRecord[];
  promoted: PromotedMemoryRecord[];
}

export interface QualityReportOptions extends StaleMemoryOptions, PromoteMemoryRecordsOptions {}

export interface MemoryQualityReport {
  inputCount: number;
  outputCount: number;
  records: MemoryRecord[];
  duplicates: DuplicateMemoryRecord[];
  conflicts: MemoryConflict[];
  staleIds: string[];
  promotedIds: string[];
}

export interface MemoryQualityAuditSummary {
  inputCount: number;
  outputCount: number;
  removedDuplicateCount: number;
  conflictCount: number;
  staleCount: number;
  promotedCount: number;
  changedCount: number;
  unchangedCount: number;
  removedIds: string[];
  updatedIds: string[];
  retainedIds: string[];
}

export interface ApplyMemoryQualityReportResult {
  records: MemoryRecord[];
  audit: MemoryQualityAuditSummary;
}

export interface SerializedMemoryQualityReport {
  inputCount: number;
  outputCount: number;
  records: MemoryRecord[];
  duplicates: DuplicateMemoryRecord[];
  conflicts: MemoryConflict[];
  staleIds: string[];
  promotedIds: string[];
  audit: MemoryQualityAuditSummary;
}

export function deduplicateMemoryRecords(records: MemoryRecord[]): DeduplicateMemoryRecordsResult {
  const entries: Array<{ key: string; record: MemoryRecord }> = [];
  const keyToIndex = new Map<string, number>();
  const duplicates: DuplicateMemoryRecord[] = [];

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

export function detectMemoryConflicts(records: MemoryRecord[]): MemoryConflict[] {
  const conflicts: MemoryConflict[] = [];

  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const left = records[leftIndex];
      const right = records[rightIndex];
      const entity = sharedEntity(left, right);
      if (!entity) continue;

      const reason = opposingLanguageReason(left.content, right.content);
      if (!reason) continue;

      conflicts.push({
        entity,
        leftId: left.id,
        rightId: right.id,
        reason
      });
    }
  }

  return conflicts;
}

export function markStaleMemoryRecords(
  records: MemoryRecord[],
  options: StaleMemoryOptions = {}
): MarkStaleMemoryRecordsResult {
  const now = options.now ?? new Date();
  const staleAfterDays = options.staleAfterDays ?? 120;
  const staleIds: string[] = [];

  return {
    records: records.map((record) => {
      if (record.status !== "active") return cloneRecord(record);
      if (ageInDays(record.updatedAt, now) <= staleAfterDays) return cloneRecord(record);

      staleIds.push(record.id);
      return {
        ...cloneRecord(record),
        status: "stale"
      };
    }),
    staleIds
  };
}

export function promoteMemoryRecords(
  records: MemoryRecord[],
  options: PromoteMemoryRecordsOptions = {}
): PromoteMemoryRecordsResult {
  const repeatThreshold = options.repeatThreshold ?? 2;
  const repeatBoost = options.repeatBoost ?? 0.2;
  const importantBoost = options.importantBoost ?? 0.15;
  const repeatedCounts = countNormalized(options.repeatedContent ?? []);
  const importantTerms = (options.importantTerms ?? []).map(normalizeMemory).filter(Boolean);
  const promoted: PromotedMemoryRecord[] = [];

  const promotedRecords = records.map((record) => {
    const normalized = normalizeMemory(record.content);
    const isRepeated = (repeatedCounts.get(normalized) ?? 0) >= repeatThreshold;
    const isImportant = importantTerms.some((term) => normalized.includes(term));
    const boost = (isRepeated ? repeatBoost : 0) + (isImportant ? importantBoost : 0);
    if (boost <= 0) return cloneRecord(record);

    const importance = clamp(record.score.importance + boost);
    if (importance === record.score.importance) return cloneRecord(record);

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

export function applyMemoryQualityReport(
  records: MemoryRecord[],
  report: MemoryQualityReport
): ApplyMemoryQualityReportResult {
  return {
    records: report.records.map(cloneRecord),
    audit: summarizeMemoryQualityReport(report, records)
  };
}

export function summarizeMemoryQualityReport(
  report: MemoryQualityReport,
  records?: MemoryRecord[]
): MemoryQualityAuditSummary {
  const removedIds = uniquePreservingOrder(report.duplicates.map((duplicate) => duplicate.duplicateId));
  const updatedIds: string[] = [];
  const retainedIds: string[] = [];

  if (records) {
    const finalById = new Map(report.records.map((record) => [record.id, record]));
    for (const record of records) {
      const finalRecord = finalById.get(record.id);
      if (!finalRecord) {
        if (!removedIds.includes(record.id)) removedIds.push(record.id);
        continue;
      }

      if (sameJsonSafeRecord(record, finalRecord)) {
        retainedIds.push(record.id);
      } else {
        updatedIds.push(record.id);
      }
    }
  } else {
    const changedIds = new Set<string>();
    for (const id of report.staleIds) changedIds.add(id);
    for (const id of report.promotedIds) changedIds.add(id);
    for (const conflict of report.conflicts) {
      changedIds.add(conflict.leftId);
      changedIds.add(conflict.rightId);
    }

    for (const record of report.records) {
      if (changedIds.has(record.id)) {
        updatedIds.push(record.id);
      } else {
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

export function serializeMemoryQualityReport(report: MemoryQualityReport): SerializedMemoryQualityReport {
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

export function createQualityReport(
  records: MemoryRecord[],
  options: QualityReportOptions = {}
): MemoryQualityReport {
  const deduplicated = deduplicateMemoryRecords(records);
  const stale = markStaleMemoryRecords(deduplicated.records, options);
  const promoted = promoteMemoryRecords(stale.records, options);
  // Superseded records are a settled verdict (a belief was explicitly replaced);
  // never re-flag them as "conflicted" — that would clobber the supersede link.
  const conflicts = detectMemoryConflicts(promoted.records.filter((record) => record.status !== "superseded"));
  const conflictedIds = new Set(conflicts.flatMap((conflict) => [conflict.leftId, conflict.rightId]));
  const finalRecords = promoted.records.map((record) =>
    conflictedIds.has(record.id)
      ? {
          ...cloneRecord(record),
          status: "conflicted" as MemoryStatus
        }
      : cloneRecord(record)
  );

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

function memoryKey(record: MemoryRecord): string {
  return `${record.type}:${normalizeMemory(record.content)}`;
}

function mergeDuplicate(kept: MemoryRecord, duplicate: MemoryRecord): MemoryRecord {
  return {
    ...cloneRecord(kept),
    score: {
      importance: clamp(Math.max(kept.score.importance, duplicate.score.importance)),
      confidence: clamp(Math.max(kept.score.confidence, duplicate.score.confidence))
    },
    entities: uniqueSorted([...kept.entities, ...duplicate.entities])
  };
}

function memoryStrength(record: MemoryRecord): number {
  return record.score.importance + record.score.confidence + epochMillis(record.updatedAt) / 1_000_000_000_000_000;
}

function sharedEntity(left: MemoryRecord, right: MemoryRecord): string | undefined {
  const rightEntities = new Map(right.entities.map((entity) => [normalizeEntity(entity), entity]));
  for (const leftEntity of left.entities) {
    const match = rightEntities.get(normalizeEntity(leftEntity));
    if (match) return leftEntity.trim() || match;
  }
  return undefined;
}

function opposingLanguageReason(left: string, right: string): string | undefined {
  const leftText = normalizeMemory(left);
  const rightText = normalizeMemory(right);
  const pairs: Array<[string, string, string]> = [
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
    if (hasWord(leftText, positive) && hasWord(rightText, negative)) return reason;
    if (hasWord(leftText, negative) && hasWord(rightText, positive)) return reason;
  }

  return undefined;
}

function ageInDays(value: string, now: Date): number {
  const updatedAt = epochMillis(value);
  if (!Number.isFinite(updatedAt)) return 0;
  return (now.getTime() - updatedAt) / 86_400_000;
}

function epochMillis(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function countNormalized(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = normalizeMemory(value);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function normalizeMemory(content: string): string {
  return content
    .toLowerCase()
    .replace(/[`"'.,;:!?()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntity(entity: string): string {
  return normalizeMemory(entity);
}

function hasWord(content: string, word: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(word)}($|\\s)`).test(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right)
  );
}

function uniquePreservingOrder(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function cloneRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    score: { ...record.score },
    source: { ...record.source },
    entities: [...record.entities]
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function safeInteger(value: number): number {
  return Number.isSafeInteger(value) ? value : 0;
}

function sameJsonSafeRecord(left: MemoryRecord, right: MemoryRecord): boolean {
  return JSON.stringify(jsonSafeRecord(left)) === JSON.stringify(jsonSafeRecord(right));
}

function jsonSafeRecord(record: MemoryRecord): MemoryRecord {
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
