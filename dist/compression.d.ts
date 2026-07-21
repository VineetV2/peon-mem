import type { PeonConfig } from "./config.js";
import type { Summarizer } from "./brain.js";
/**
 * Builds the LLM summarizer the brain uses to compress a topic cluster into one
 * gist belief. Kept separate from brain.ts so the curation logic stays pure and
 * testable; this is the only network-touching piece. Returns null when AI is off
 * or no key is configured (the brain then runs cost-free, skipping compression).
 */
export declare function createClusterSummarizer(config: PeonConfig): Summarizer | null;
