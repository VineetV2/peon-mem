import type { PeonConfig } from "./config.js";
import type { FetchLike } from "./reranker.js";

/**
 * HyDE — Hypothetical Document Embeddings (Gao et al., 2022).
 *
 * A short, vague query ("how do we handle retries?") often shares few tokens — and little
 * embedding mass — with the belief that actually answers it ("Route webhook retries through
 * the durable queue with exponential backoff"). HyDE closes that gap: a small LLM writes a
 * HYPOTHETICAL answer to the query, and we retrieve against THAT richer text instead of the
 * bare query. The hypothetical may be factually wrong — it doesn't matter; its job is to land
 * in the right neighborhood of the embedding/lexical space so the real, stored answer ranks up.
 *
 * We return an EXPANDED query = original query + hypothetical. Keeping the original terms means
 * lexical matching stays anchored on what the user literally asked, while the hypothetical adds
 * the vocabulary and semantic signal that pure query embedding lacks. Opt-in and fail-safe:
 * with no API key, AI disabled, or any error, it returns the original query untouched.
 */

export interface HydeOptions {
  config: PeonConfig;
  model?: string;
  fetchImpl?: FetchLike;
  /** Cap on the generated hypothetical (keeps prompt cost and noise down). Default 320. */
  maxChars?: number;
}

export interface HydeResult {
  /** original + hypothetical, for use as the retrieval query. Equals original on any failure. */
  expanded: string;
  /** the generated hypothetical answer alone (empty if generation was skipped/failed). */
  hypothetical: string;
}

const DEFAULT_MAX_CHARS = 320;

export async function expandQuery(query: string | undefined, options: HydeOptions): Promise<HydeResult> {
  const q = (query ?? "").trim();
  if (!q) return { expanded: "", hypothetical: "" };
  const { config } = options;
  if (config.aiMode === "off" || !config.openRouterApiKey) return { expanded: q, hypothetical: "" };

  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!doFetch) return { expanded: q, hypothetical: "" };
  const maxChars = Math.max(80, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS));

  const system =
    "You write a brief HYPOTHETICAL answer used only to improve memory retrieval. " +
    "Given a question, write 1-3 plausible sentences that such an answer might contain, " +
    "using concrete, specific vocabulary (entities, file names, decisions, values). " +
    "Do not hedge, do not say you lack context, do not ask questions. Output the sentences only.";
  const user = `Question: ${q}\n\nHypothetical answer:`;

  try {
    const response = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.3
      })
    });
    if (!response.ok) return { expanded: q, hypothetical: "" };
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (json.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return { expanded: q, hypothetical: "" };
    const hypothetical = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw;
    return { expanded: `${q}\n${hypothetical}`, hypothetical };
  } catch {
    return { expanded: q, hypothetical: "" };
  }
}
