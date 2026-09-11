// ── One queue for every background model call ───────────────────────────────────────
// Consolidation, entity extraction, global extraction, compression and recuration all
// call the same model server. A local server works one generation at a time: anything
// sent alongside only queues inside it, where Node's 300 s header limit can expire before
// it is served. Measured: while a consolidation ran, global extraction and compression
// hit the server outside the consolidation's slot; two 4-minute generations ran side by
// side, and a second project's consolidation sat 25+ minutes unanswered in the queue.
//
// So each individual model request takes a slot here, FIFO, and releases it when the
// response arrives. Calls must never nest (a slotted call making another slotted call
// would deadlock at a limit of 1). Query-time embeddings are not model calls and are not
// queued here; they have their own short deadline.
class Semaphore {
    limit;
    active = 0;
    waiting = [];
    constructor(limit) {
        this.limit = limit;
    }
    async run(task) {
        if (this.active < this.limit)
            this.active += 1;
        else
            await new Promise((resume) => this.waiting.push(resume)); // a finishing call hands its slot over
        try {
            return await task();
        }
        finally {
            const next = this.waiting.shift();
            if (next)
                next();
            else
                this.active -= 1;
        }
    }
}
let slots;
/**
 * Run one model request in the shared pool. Sized on first use: 1 for a local provider,
 * 2 for a hosted one; PEON_CONSOLIDATION_CONCURRENCY overrides either.
 */
export function withModelSlot(config, call) {
    slots ??= new Semaphore(Math.max(1, config.consolidationConcurrency ?? (config.provider === "ollama" ? 1 : 2)));
    return slots.run(call);
}
/** An explicit deadline for one model request (PEON_LLM_TIMEOUT_MS, default 600 s). */
export function modelDeadline(config) {
    return AbortSignal.timeout(config.llmTimeoutMs ?? 600_000);
}
/** Test hook: forget the pool so the next call sizes it from its own config. */
export function resetModelSlots() {
    slots = undefined;
}
