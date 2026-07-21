import type { PeonConfig } from "./config.js";
import type { MemoryRecord } from "./types.js";
/**
 * One-time cleanup: re-judge a project's EXISTING beliefs against the sharpened
 * rules and return the ids to retire. Operates on already-distilled beliefs (not
 * raw events) so it's cheap, preserves supersession history, and only removes the
 * ephemeral/trivial/duplicate noise the old prompt let through. Removed beliefs are
 * archived (recoverable), never deleted.
 */
export type Recurator = (records: readonly MemoryRecord[]) => Promise<string[]>;
export declare function createRecurator(config: PeonConfig): Recurator | null;
/** Tolerant parse of the model's id list. */
export declare function parseIdArray(content: string): string[];
