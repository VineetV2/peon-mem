import { stat } from "node:fs/promises";
// ── Skipping idle brain passes ────────────────────────────────────────────────────────
// The daemon's heartbeat runs a brain pass over every project every 3 minutes. Each pass read
// the whole brain, took the write lock, rewrote memories/graph/entities, synced embeddings and
// wrote a full backup snapshot, even when nothing had changed. Curation is deterministic over
// its input, so a pass over a brain untouched since the last pass finds nothing new. Such a
// pass is skipped unless memories were recalled (reinforcement has work to do), compression
// was asked for, or the idle window (default 1 hour) has elapsed, which keeps the slow
// strength relaxation of idle brains going at a lower rate.
const DEFAULT_IDLE_WINDOW_MS = 60 * 60_000;
let idleWindowMs = DEFAULT_IDLE_WINDOW_MS;
const lastPassByFile = new Map();
/** Test hook: how long an unchanged brain may go without a pass. */
export function setBrainPassIdleWindow(ms) {
    idleWindowMs = ms;
}
/** Test hook: forget completed passes and restore the default window. */
export function resetBrainPassGate() {
    idleWindowMs = DEFAULT_IDLE_WINDOW_MS;
    lastPassByFile.clear();
}
/** True when the brain file is unchanged since the last completed pass, and that pass was recent. */
export async function isIdleSinceLastPass(file) {
    const previous = lastPassByFile.get(file);
    if (!previous || Date.now() - previous.at >= idleWindowMs)
        return false;
    const current = await stat(file).catch(() => undefined);
    return current !== undefined && current.mtimeMs === previous.mtimeMs && current.size === previous.size;
}
/** Remember the brain file as it stands after a completed pass. */
export async function recordCompletedPass(file) {
    const current = await stat(file).catch(() => undefined);
    if (current)
        lastPassByFile.set(file, { mtimeMs: current.mtimeMs, size: current.size, at: Date.now() });
}
