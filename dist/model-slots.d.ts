import type { PeonConfig } from "./config.js";
/**
 * Run one model request in the shared pool. Sized on first use: 1 for a local provider,
 * 2 for a hosted one; PEON_CONSOLIDATION_CONCURRENCY overrides either.
 */
export declare function withModelSlot<T>(config: PeonConfig, call: () => Promise<T>): Promise<T>;
/** An explicit deadline for one model request (PEON_LLM_TIMEOUT_MS, default 600 s). */
export declare function modelDeadline(config: PeonConfig): AbortSignal;
/** Test hook: forget the pool so the next call sizes it from its own config. */
export declare function resetModelSlots(): void;
