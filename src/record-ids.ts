import type { MemoryRecord } from "./types.js";

/**
 * Every record id must be unique: the embedding sidecar, supersede links, the monitor and
 * id-keyed curation all assume it. Topic compression used to derive a summary's id from its
 * topic alone, so each recompression of a topic reused the previous summary's id. A live
 * 32k-memory brain carried 220 such ids shared by 912 extra copies, and because the sidecar
 * keeps one hash per id, those copies were re-embedded on every 3-minute pulse, forever.
 *
 * The liveliest copy (active first, then most recently updated) keeps the id. Every other
 * copy gets a stable id derived from its own content, and the archived members it summarized
 * are pointed at that new id. Pure: returns new records and never mutates the input.
 */
export function ensureUniqueRecordIds(records: readonly MemoryRecord[]): { records: MemoryRecord[]; reassigned: number } {
  const indexesById = new Map<string, number[]>();
  records.forEach((record, index) => indexesById.set(record.id, [...(indexesById.get(record.id) ?? []), index]));
  const shared = [...indexesById.entries()].filter(([, indexes]) => indexes.length > 1);
  if (shared.length === 0) return { records: [...records], reassigned: 0 };

  const taken = new Set(records.map((record) => record.id));
  const newIdByIndex = new Map<number, string>();
  // member id -> the summary id it should now point at, keyed by the id it points at today
  const memberMoves = new Map<string, Map<string, string>>();

  for (const [id, indexes] of shared) {
    const ordered = [...indexes].sort(
      (a, b) =>
        statusRank(records[a]) - statusRank(records[b]) ||
        (records[b].updatedAt ?? "").localeCompare(records[a].updatedAt ?? "") ||
        a - b
    );
    const keeper = records[ordered[0]];
    const keeperMembers = new Set(keeper.summaryOf ?? []);
    for (const index of ordered.slice(1)) {
      const copy = records[index];
      const seed = `${copy.type}\n${copy.content}\n${copy.createdAt}`;
      let candidate = `${id}_${fnv1a(seed)}`;
      for (let n = 2; taken.has(candidate); n += 1) candidate = `${id}_${fnv1a(`${seed}\n${n}`)}`;
      taken.add(candidate);
      newIdByIndex.set(index, candidate);
      for (const member of copy.summaryOf ?? []) {
        if (keeperMembers.has(member)) continue;
        const moves = memberMoves.get(member) ?? new Map<string, string>();
        moves.set(id, candidate);
        memberMoves.set(member, moves);
      }
    }
  }

  const out = records.map((record, index) => {
    const newId = newIdByIndex.get(index);
    const movedTo = record.summarizedBy ? memberMoves.get(record.id)?.get(record.summarizedBy) : undefined;
    if (!newId && !movedTo) return record;
    return { ...record, ...(newId ? { id: newId } : {}), ...(movedTo ? { summarizedBy: movedTo } : {}) };
  });
  return { records: out, reassigned: newIdByIndex.size };
}

const STATUS_RANK: Record<string, number> = { active: 0, conflicted: 1, stale: 2, superseded: 3, archived: 4 };

function statusRank(record: MemoryRecord): number {
  return STATUS_RANK[record.status] ?? 5;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
