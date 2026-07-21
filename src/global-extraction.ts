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

export function createGlobalExtractor(config: PeonConfig): GlobalExtractor | null {
  if (config.aiMode === "off" || !config.openRouterApiKey) return null;
  return async (records: readonly MemoryRecord[]): Promise<string[]> => {
    // Send the highest-signal beliefs only — bounds tokens, focuses the model.
    const candidates = records
      .filter((r) => r.status === "active" && r.type !== "timeline" && r.type !== "open_question")
      .sort((a, b) => b.score.importance - a.score.importance)
      .slice(0, 60);
    if (candidates.length === 0) return [];
    const list = candidates.map((r, i) => `${i + 1}. [${r.type}] ${r.content}`).join("\n");
    const system =
      "You curate a user's GLOBAL memory — facts true across ALL of their projects, independent of which one they work on. " +
      "The beliefs below come from working ON one specific software/research project. " +
      "CRITICAL: that project's OWN internals are NOT global, even when they sound general — exclude its tools, APIs, " +
      "architecture, modules, data model, config flags, UI, code decisions, and bugs. If a fact describes how the project " +
      "being analyzed is built or behaves, DROP it. " +
      "Extract ONLY facts about the USER and their broader environment that would hold in a completely different project: " +
      "their compute hardware and clusters (names, hostnames, GPUs, scratch paths), OS, external accounts/services, " +
      "shell/CLI habits and tools they reuse everywhere (rsync, gh, SLURM commands), and durable personal facts. " +
      "Example KEEP: 'The user runs GPU jobs on the NJIT Wulver cluster via SLURM.' " +
      "Example DROP (project-internal): 'The daemon exposes a /global/extract endpoint.' " +
      "Rewrite each as one self-contained sentence with zero project context. " +
      "Output ONLY a JSON array of strings — no markdown fences, no prose. If nothing qualifies, return []. Max 8 items.";
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Project beliefs:\n${list}\n\nGlobal facts (JSON array):` }
        ],
        temperature: 0.1
      })
    });
    if (!response.ok) throw new Error(`global extraction failed with ${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseStringArray(json.choices?.[0]?.message?.content ?? "");
  };
}

/** Tolerant parse of the model's reply into a clean string list. */
export function parseStringArray(content: string): string[] {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  try {
    const parsed = JSON.parse(body || text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}
