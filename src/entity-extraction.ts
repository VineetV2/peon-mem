import type { PeonConfig } from "./config.js";
import type { FetchLike } from "./reranker.js";

/**
 * Model-grade DOMAIN entity extraction. The deterministic resolver (entities.ts) reliably catches
 * files/symbols and obvious products/proper-nouns, but it misses the domain knowledge that matters
 * most for associative recall — people, papers, methods, datasets, organizations stated in prose
 * ("the professor's MaskSQL idea", "AskData on BIRD"). The consolidation panel's one firm
 * conclusion was that entity extraction is THE place model quality earns its keep (unlike
 * consolidation fidelity, where it's marginal). So this runs ONE batched LLM pass over the belief
 * snippets and returns the named entities per snippet, to be MERGED with the deterministic set.
 *
 * Strictly optional + fail-safe: no API key, AI disabled, empty input, or any LLM/parse failure
 * returns an empty map and the caller keeps the deterministic entities. Injectable fetch for tests.
 */

export interface ExtractItem {
  /** Stable key the caller maps results back by (e.g. normalized content). */
  key: string;
  content: string;
}

export interface ExtractOptions {
  config: PeonConfig;
  model?: string;
  fetchImpl?: FetchLike;
  /** Max snippets per call + per-snippet char cap (keeps the prompt and cost bounded). */
  maxItems?: number;
  snippetChars?: number;
}

const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_SNIPPET_CHARS = 240;

export async function extractDomainEntitiesViaModel(items: ExtractItem[], options: ExtractOptions): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const { config } = options;
  if (items.length === 0 || config.aiMode === "off" || !config.openRouterApiKey) return out;
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch) return out;

  const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const snippetChars = Math.max(40, Math.trunc(options.snippetChars ?? DEFAULT_SNIPPET_CHARS));
  const batch = items.slice(0, maxItems);
  const numbered = batch.map((it, i) => `${i + 1}. ${truncate(it.content, snippetChars)}`).join("\n");

  const system =
    "You extract NAMED DOMAIN entities from memory snippets for a knowledge graph. For each numbered " +
    "snippet, list the specific named entities it mentions: people, papers/methods/models, datasets, " +
    "projects, organizations, and distinctive technical concepts. Use each entity's canonical surface " +
    "form. EXCLUDE generic words, file paths, and code identifiers. Return ONLY a JSON array of objects " +
    '{"n": <snippet number>, "entities": ["..."]}, empty array when a snippet names none. No prose, no fences.';
  const user = `Snippets:\n${numbered}\n\nJSON array:`;

  try {
    const response = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0
      })
    });
    if (!response.ok) return out;
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseEntityArray(json.choices?.[0]?.message?.content ?? "");
    for (const row of parsed) {
      const idx = row.n - 1;
      if (idx >= 0 && idx < batch.length && row.entities.length > 0) {
        out.set(batch[idx].key, row.entities);
      }
    }
    return out;
  } catch {
    return out; // any failure → deterministic-only
  }
}

/** Tolerant parse of `[{n, entities:[...]}, ...]` from a model response. */
export function parseEntityArray(content: string): Array<{ n: number; entities: string[] }> {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => ({
        n: typeof row?.n === "number" ? Math.trunc(row.n) : Number.parseInt(String(row?.n), 10),
        entities: Array.isArray(row?.entities)
          ? row.entities.filter((e: unknown) => typeof e === "string" && e.trim().length > 1).map((e: string) => e.trim()).slice(0, 12)
          : []
      }))
      .filter((row) => Number.isInteger(row.n));
  } catch {
    return [];
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
