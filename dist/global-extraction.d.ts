import type { PeonConfig } from "./config.js";
import type { MemoryRecord } from "./types.js";
/**
 * The AI-judged path that lets global memory actually build up. A blunt type rule
 * can't tell "the user runs on the NJIT cluster" (global) from "use flash_attention_2
 * to match this paper" (project-local) — both are `preference`s. So we ask the cheap
 * consolidation model to pick out ONLY the cross-cutting beliefs.
 *
 * Returns a function that takes a project's beliefs and yields concise global facts.
 * null when AI is off / no key (global then only grows via explicit promotion).
 */
export type GlobalExtractor = (records: readonly MemoryRecord[]) => Promise<string[]>;
export declare function createGlobalExtractor(config: PeonConfig): GlobalExtractor | null;
/** Tolerant parse of the model's reply into a clean string list. */
export declare function parseStringArray(content: string): string[];
