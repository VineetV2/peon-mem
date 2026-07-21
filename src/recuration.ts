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

const BATCH_SIZE = 30;
const PER_BATCH_MAX_FRACTION = 0.4; // a batch that wants to drop more than this is misjudging — skip it

export function createRecurator(config: PeonConfig): Recurator | null {
  if (config.aiMode === "off" || !config.openRouterApiKey) return null;
  return async (records: readonly MemoryRecord[]): Promise<string[]> => {
    const active = records.filter((r) => r.status === "active" && !r.pinned);
    if (active.length === 0) return [];
    // Judge in small batches — the model reasons reliably over ~30 beliefs but
    // over-selects wildly when handed hundreds at once.
    const drop: string[] = [];
    for (let i = 0; i < active.length; i += BATCH_SIZE) {
      const batch = active.slice(i, i + BATCH_SIZE);
      const ids = await judgeBatch(config, batch).catch(() => []);
      const valid = ids.filter((id) => batch.some((r) => r.id === id));
      // Per-batch rogue guard: if a batch wants to drop most of itself, skip it entirely.
      if (valid.length > Math.max(3, Math.floor(batch.length * PER_BATCH_MAX_FRACTION))) continue;
      drop.push(...valid);
    }
    return drop;
  };
}

async function judgeBatch(config: PeonConfig, batch: readonly MemoryRecord[]): Promise<string[]> {
    const list = batch.map((r) => `${r.id} | ${r.type} | ${r.content}`).join("\n");
    const system =
      "You are CONSERVATIVELY trimming a project's memory. Each line is 'id | type | content'. " +
      "Default action is KEEP. Remove a belief ONLY if it is unmistakably one of: " +
      "(a) an ephemeral one-time ACTION with no lasting meaning — 'cloned the repo', 'installed deps', 'created a directory', " +
      "'downloaded weights', 'submitted/monitored a job', 'confirmed the job is pending', 'added a warning filter'; OR " +
      "(b) an EXACT duplicate of another belief in the list (keep one, remove the literal repeats). " +
      "Do NOT remove anything for being merely 'less important', verbose, or arguable — only clear noise and exact dupes. " +
      "KEEP every decision, result/metric, preference, file, and open question unless it is pure setup-action noise. " +
      "You should typically remove only a small fraction; removing most beliefs is WRONG. When in any doubt, KEEP. " +
      "Output ONLY a JSON array of the ids to remove — no fences, no prose. If none, return [].";
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Beliefs:\n${list}\n\nIds to remove (JSON array):` }
        ],
        temperature: 0.1
      })
    });
    if (!response.ok) throw new Error(`recuration failed with ${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseIdArray(json.choices?.[0]?.message?.content ?? "");
}

/** Tolerant parse of the model's id list. */
export function parseIdArray(content: string): string[] {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  try {
    const parsed = JSON.parse(body || text);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
