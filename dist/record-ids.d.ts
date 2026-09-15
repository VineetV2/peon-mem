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
export declare function ensureUniqueRecordIds(records: readonly MemoryRecord[]): {
    records: MemoryRecord[];
    reassigned: number;
};
