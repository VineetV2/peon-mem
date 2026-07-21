import type { PeonConfig } from "./config.js";
import type { Summarizer, TopicCluster } from "./brain.js";

/**
 * Builds the LLM summarizer the brain uses to compress a topic cluster into one
 * gist belief. Kept separate from brain.ts so the curation logic stays pure and
 * testable; this is the only network-touching piece. Returns null when AI is off
 * or no key is configured (the brain then runs cost-free, skipping compression).
 */
export function createClusterSummarizer(config: PeonConfig): Summarizer | null {
  if (config.aiMode === "off" || !config.openRouterApiKey) return null;
  return async (cluster: TopicCluster): Promise<string> => {
    const beliefs = cluster.members.map((m, i) => `${i + 1}. ${m.content}`).join("\n");
    const system =
      "You compress several related memory beliefs into ONE durable summary belief. " +
      "PRESERVE every concrete fact verbatim — names, numbers, metrics, file paths, hostnames, decisions. " +
      "Losing a specific fact is a failure; merge wording, never drop information. Drop only redundancy and filler. " +
      "Output ONLY the summary sentence(s) — no preamble, no markdown, no quotes around it. Max 240 characters.";
    const user = `Topic: ${cluster.entity}\n\nBeliefs to compress:\n${beliefs}\n\nOne compact summary:`;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openRouterApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.processingModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        temperature: 0.1
      })
    });
    if (!response.ok) throw new Error(`compression failed with ${response.status}`);
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("compression returned no content");
    return content.slice(0, 280);
  };
}
