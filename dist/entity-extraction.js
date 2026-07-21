const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_SNIPPET_CHARS = 240;
export async function extractDomainEntitiesViaModel(items, options) {
    const out = new Map();
    const { config } = options;
    if (items.length === 0 || config.aiMode === "off" || !config.openRouterApiKey)
        return out;
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (!doFetch)
        return out;
    const maxItems = Math.max(1, Math.trunc(options.maxItems ?? DEFAULT_MAX_ITEMS));
    const snippetChars = Math.max(40, Math.trunc(options.snippetChars ?? DEFAULT_SNIPPET_CHARS));
    const batch = items.slice(0, maxItems);
    const numbered = batch.map((it, i) => `${i + 1}. ${truncate(it.content, snippetChars)}`).join("\n");
    const system = "You extract NAMED DOMAIN entities from memory snippets for a knowledge graph. For each numbered " +
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
        if (!response.ok)
            return out;
        const json = (await response.json());
        const parsed = parseEntityArray(json.choices?.[0]?.message?.content ?? "");
        for (const row of parsed) {
            const idx = row.n - 1;
            if (idx >= 0 && idx < batch.length && row.entities.length > 0) {
                out.set(batch[idx].key, row.entities);
            }
        }
        return out;
    }
    catch {
        return out; // any failure → deterministic-only
    }
}
/** Tolerant parse of `[{n, entities:[...]}, ...]` from a model response. */
export function parseEntityArray(content) {
    const match = content.match(/\[[\s\S]*\]/);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map((row) => ({
            n: typeof row?.n === "number" ? Math.trunc(row.n) : Number.parseInt(String(row?.n), 10),
            entities: Array.isArray(row?.entities)
                ? row.entities.filter((e) => typeof e === "string" && e.trim().length > 1).map((e) => e.trim()).slice(0, 12)
                : []
        }))
            .filter((row) => Number.isInteger(row.n));
    }
    catch {
        return [];
    }
}
function truncate(text, max) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
