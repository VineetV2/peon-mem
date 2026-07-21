const DEFAULT_TOP_K = 20;
const DEFAULT_SNIPPET_CHARS = 240;
export async function rerankRecords(query, records, options) {
    const { config } = options;
    const q = (query ?? "").trim();
    // Cheap exits — never pay an LLM call when it cannot help.
    if (!q || records.length < 2)
        return records;
    if (config.aiMode === "off" || !config.openRouterApiKey)
        return records;
    const topK = Math.max(2, Math.trunc(options.topK ?? DEFAULT_TOP_K));
    const snippetChars = Math.max(40, Math.trunc(options.snippetChars ?? DEFAULT_SNIPPET_CHARS));
    const head = records.slice(0, topK);
    const tail = records.slice(topK);
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (!doFetch)
        return records;
    const numbered = head
        .map((item, i) => `${i + 1}. [${item.record.type}] ${truncate(item.record.content, snippetChars)}`)
        .join("\n");
    const system = "You are a precision reranker for a memory system. Given a user query and a numbered list " +
        "of candidate memory snippets, decide which snippets best help answer the query. " +
        "Return ONLY a JSON array of the candidate numbers, ordered from most to least relevant. " +
        "Include every number exactly once. No prose, no code fences.";
    const user = `Query: ${q}\n\nCandidates:\n${numbered}\n\nJSON array of numbers (most relevant first):`;
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
                temperature: 0
            })
        });
        if (!response.ok)
            return records;
        const json = (await response.json());
        const content = json.choices?.[0]?.message?.content ?? "";
        const order = parseOrder(content, head.length);
        if (order.length === 0)
            return records;
        // Apply the model's order to the head, then append any head items it omitted (in their
        // original order), then the untouched tail. Guarantees a permutation of the input.
        const seen = new Set();
        const reorderedHead = [];
        for (const n of order) {
            const idx = n - 1;
            if (idx >= 0 && idx < head.length && !seen.has(idx)) {
                seen.add(idx);
                reorderedHead.push(head[idx]);
            }
        }
        for (let i = 0; i < head.length; i++)
            if (!seen.has(i))
                reorderedHead.push(head[i]);
        return [...reorderedHead, ...tail];
    }
    catch {
        return records; // any failure → first-pass order, never worse than before
    }
}
/** Extract the leading JSON array of positive integers from a model response, tolerant of stray prose/fences. */
export function parseOrder(content, max) {
    const match = content.match(/\[[\s\S]*?\]/);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map((n) => (typeof n === "number" ? Math.trunc(n) : Number.parseInt(String(n), 10)))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= max);
    }
    catch {
        return [];
    }
}
function truncate(text, max) {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
