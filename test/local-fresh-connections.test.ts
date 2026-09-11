import { afterEach, describe, expect, test, vi } from "vitest";
import { llmHeaders, loadPeonConfig } from "../src/config.js";
import { OllamaEmbeddingClient } from "../src/embeddings.js";
import { OpenRouterMemoryModelClient } from "../src/processor.js";

/**
 * Measured against the M1 over Tailscale: six sequential 64-text embedding batches over one
 * keep-alive connection -> 2 got stuck (the ~310 KB reply sat in the server's send queue);
 * the same six with a fresh connection each -> 6/6 in 2.8 s. Requests to a local model
 * server therefore always ask for a fresh connection; hosted providers keep keep-alive.
 */

afterEach(() => vi.unstubAllGlobals());

const local = () => loadPeonConfig({ PEON_PROVIDER: "ollama", PEON_LLM_BASE_URL: "http://m1.test:11434/v1", PEON_EMBEDDING_MODE: "local" });
const hosted = () => loadPeonConfig({ PEON_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-test", PEON_EMBEDDING_MODE: "local" });
const header = (h: Record<string, string>, name: string) =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];

describe("requests to a local model server use a fresh connection", () => {
  test("llmHeaders asks for Connection: close for ollama, not for hosted providers", () => {
    expect(header(llmHeaders(local()), "connection")).toBe("close");
    expect(header(llmHeaders(hosted()), "connection")).toBeUndefined();
  });

  test("every embedding batch asks for a fresh connection, not only the retry", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ embeddings: [[1, 0, 0], [0, 1, 0]] }), { status: 200 });
    }) as unknown as typeof fetch;
    // Two unique texts: a batch bypasses the single-query cache, so the request really goes out.
    const stamp = String(Date.now());
    await new OllamaEmbeddingClient({ model: `fresh-conn-${stamp}`, baseUrl: "http://m1.test:11434", fetchImpl }).embed([`a ${stamp}`, `b ${stamp}`]);
    expect(header(seen[0] ?? {}, "connection")).toBe("close");
  });

  test("the consolidation request to ollama asks for a fresh connection", async () => {
    let sent: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      sent = { ...(init.headers as Record<string, string>) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"ok"}' } }] }));
    });
    await new OpenRouterMemoryModelClient().processMemory({ rawMemory: "a session log", config: local(), reason: "t" });
    expect(header(sent, "connection")).toBe("close");
  });
});
