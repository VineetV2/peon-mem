const DEFAULT_MAX_CHARS = 320;
export async function expandQuery(query, options) {
    const q = (query ?? "").trim();
    if (!q)
        return { expanded: "", hypothetical: "" };
    const { config } = options;
    if (config.aiMode === "off" || !config.openRouterApiKey)
        return { expanded: q, hypothetical: "" };
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    if (!doFetch)
        return { expanded: q, hypothetical: "" };
    const maxChars = Math.max(80, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS));
    const system = "You write a brief HYPOTHETICAL answer used only to improve memory retrieval. " +
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
        if (!response.ok)
            return { expanded: q, hypothetical: "" };
        const json = (await response.json());
        const raw = (json.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
        if (!raw)
            return { expanded: q, hypothetical: "" };
        const hypothetical = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw;
        return { expanded: `${q}\n${hypothetical}`, hypothetical };
    }
    catch {
        return { expanded: q, hypothetical: "" };
    }
}
