import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import {
  OpenRouterMemoryModelClient,
  PeonMemoryProcessor,
  detectPromptTruncation,
  estimatePromptTokensForTruncation
} from "../src/processor.js";
import { loadPeonConfig } from "../src/config.js";

/**
 * Ollama's default context window is 4096 tokens. Peon's consolidation prompt runs
 * ~22K. Ollama does not error — it silently keeps only the LAST 4096 tokens, which
 * throws away the system prompt and JSON schema. The model then returns `{}` and the
 * session is marked consumed with nothing learned. Measured on a real brain: three
 * consolidations in a row produced zero records this way, with no error anywhere.
 *
 * OpenAI-compatible servers report usage.prompt_tokens — what the model actually
 * processed. When that is far below what Peon sent, the prompt was truncated.
 */

afterEach(() => vi.unstubAllGlobals());

function ollamaConfig() {
  return loadPeonConfig({
    PEON_PROVIDER: "ollama",
    PEON_LLM_BASE_URL: "http://model-server.test:11434/v1",
    PEON_PROCESSING_MODEL: "qwen2.5:7b",
    PEON_EMBEDDING_MODE: "local",
    PEON_AI_MODE: "gated"
  });
}

/** A chat-completions response whose usage says how much of the prompt was processed. */
function stubModelServer(promptTokens: number | undefined, content = '{"summary":"ok","decisions":[]}') {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        ...(promptTokens === undefined ? {} : { usage: { prompt_tokens: promptTokens, completion_tokens: 12 } })
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const LONG_LOG = "The daemon wedged on a quadratic conflict scan and was fixed. ".repeat(1400); // ~87K chars

describe("detectPromptTruncation", () => {
  test("flags a prompt the server capped at its window", () => {
    // measured: 4096 reported vs ~17,334 estimated (ratio 0.24)
    expect(detectPromptTruncation(17334, 4096)).toBe(true);
  });

  test("does not flag a full prompt, even though chars/4 over-estimates English", () => {
    // measured on the same text with a 32K window: 12,625 vs 17,334 (ratio 0.73)
    expect(detectPromptTruncation(17334, 12625)).toBe(false);
  });

  test("cannot tell when the server reports no usage", () => {
    expect(detectPromptTruncation(17334, undefined)).toBe(false);
    expect(detectPromptTruncation(17334, 0)).toBe(false);
  });

  test("ignores small prompts where estimation noise dominates", () => {
    expect(detectPromptTruncation(900, 300)).toBe(false);
  });
});

describe("consolidation refuses a truncated prompt", () => {
  test("the model client throws an actionable error when the server truncated", async () => {
    stubModelServer(4096);
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" })
    ).rejects.toThrow(/truncated[\s\S]*context window[\s\S]*num_ctx/i);
  });

  test("a full, untruncated prompt is accepted", async () => {
    stubModelServer(20000);
    const client = new OpenRouterMemoryModelClient();
    const res = await client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" });
    expect(res.content).toContain("summary");
  });

  test("a server that reports no usage is not blocked", async () => {
    stubModelServer(undefined);
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: LONG_LOG, config: ollamaConfig(), reason: "test" })
    ).resolves.toBeDefined();
  });

  test("the session log is NOT consumed, so it is consolidated properly once fixed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-truncation-"));
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "test", cwd: projectPath });
    // Realistic session: many moderate turns, each well under the 60K delta cap, so the
    // first consolidation round genuinely carries a large prompt. (One giant message
    // would be deferred to a second round behind the small session_started event.)
    const turn = "We found the daemon wedging on a quadratic conflict scan and fixed it. ".repeat(55);
    for (let i = 0; i < 12; i += 1) {
      await store.recordMessage({ sessionId: session.id, role: i % 2 ? "assistant" : "user", content: `${i}: ${turn}` });
    }

    const before = (await store.readProcessingState()).lastProcessedEventId;
    stubModelServer(4096);
    const processor = new PeonMemoryProcessor({ config: ollamaConfig() });

    await expect(processor.processMemory({ projectPath, reason: "test" })).rejects.toThrow(/truncated/i);

    // The cursor must not move past data that was never actually consolidated.
    const after = (await (await PeonMemoryStore.open({ projectPath })).readProcessingState()).lastProcessedEventId;
    expect(after).toBe(before);
  });
});

// ── Token-dense scripts ──────────────────────────────────────────────────────────────
// chars/4 fits English but undercounts CJK badly (~0.45-1.0 tokens per character, not
// 0.25), so a truncated CJK-heavy prompt looked untruncated. The detector now uses a
// script-aware estimate. It must also not over-count alphabetic non-Latin scripts, which
// modern tokenizers pack tightly: a false positive blocks consolidation forever.

const CJK_TEXT = "记忆整合在本地模型上运行会话日志不会丢失"; // 20 Han characters, no punctuation
const CYRILLIC_TEXT = "Памятьконсолидируетсялокальноймоделью"; // 37 Cyrillic letters
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** English as the real consolidation prompt measures it: ~5.5 chars per token. */
const ENGLISH_CHARS_PER_TOKEN = 5.5;

/**
 * A model server that tokenizes what it receives at fixed per-script rates and, like
 * Ollama, silently keeps only the last `window` tokens. usage.prompt_tokens is what it read.
 */
function stubTokenizingServer(window: number, rates: { dense: number; other: number }) {
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const { messages } = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    let tokens = 0;
    for (const ch of messages.map((m) => m.content).join("")) {
      const cp = ch.codePointAt(0) ?? 0;
      tokens += cp < 0x80 ? 1 / ENGLISH_CHARS_PER_TOKEN : DENSE.test(ch) ? rates.dense : rates.other;
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"summary":"ok","decisions":[]}' } }],
        usage: { prompt_tokens: Math.min(window, Math.round(tokens)), completion_tokens: 12 }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("estimatePromptTokensForTruncation", () => {
  test("ASCII is chars/4, so English detection is unchanged", () => {
    expect(estimatePromptTokensForTruncation("x".repeat(4001))).toBe(1001);
  });

  test("CJK ideographs, kana, hangul and CJK punctuation count 0.75 each", () => {
    expect(estimatePromptTokensForTruncation("中".repeat(1000))).toBe(750);
    expect(estimatePromptTokensForTruncation("あ".repeat(1000))).toBe(750);
    expect(estimatePromptTokensForTruncation("カ".repeat(1000))).toBe(750);
    expect(estimatePromptTokensForTruncation("한".repeat(1000))).toBe(750);
    expect(estimatePromptTokensForTruncation("。".repeat(1000))).toBe(750);
  });

  test("other non-ASCII (Cyrillic, Greek, accented Latin) counts 0.35 each", () => {
    expect(estimatePromptTokensForTruncation("я".repeat(1000))).toBe(350);
    expect(estimatePromptTokensForTruncation("λ".repeat(1000))).toBe(350);
    expect(estimatePromptTokensForTruncation("é".repeat(1000))).toBe(350);
  });

  test("counts code points, not UTF-16 units (astral CJK is one character)", () => {
    const astral = "\u{20000}".repeat(4); // CJK Extension B: 4 characters, 8 UTF-16 units
    expect(astral.length).toBe(8);
    expect(estimatePromptTokensForTruncation(astral)).toBe(3);
  });
});

describe("truncation detection on token-dense scripts", () => {
  const systemPrompt = "x".repeat(6000); // ~1,500 estimated, ~1,091 real at 5.5 chars/token
  const systemReal = 6000 / ENGLISH_CHARS_PER_TOKEN;

  test("a CJK-heavy prompt truncated to 4096 is detected (chars/4 missed it)", () => {
    const delta = CJK_TEXT.repeat(600); // 12,000 characters, the reviewer's example
    const charsOverFour = Math.ceil(systemPrompt.length / 4) + Math.ceil(delta.length / 4);
    expect(charsOverFour).toBe(4500);
    expect(detectPromptTruncation(charsOverFour, 4096)).toBe(false); // the gap being fixed

    const estimate = estimatePromptTokensForTruncation(systemPrompt) + estimatePromptTokensForTruncation(delta);
    expect(estimate).toBe(10500);
    expect(detectPromptTruncation(estimate, 4096)).toBe(true);
  });

  test.each([0.45, 0.5, 0.6])(
    "an untruncated pure-CJK prompt at %s tokens/char (efficient tokenizer) is not flagged",
    (tokensPerChar) => {
      const delta = CJK_TEXT.repeat(2500); // 50,000 characters
      const estimate = estimatePromptTokensForTruncation(systemPrompt) + estimatePromptTokensForTruncation(delta);
      const reported = Math.round(systemReal + tokensPerChar * delta.length);
      expect(reported / estimate).toBeGreaterThan(0.5);
      expect(detectPromptTruncation(estimate, reported)).toBe(false);
    }
  );

  test("an untruncated Cyrillic prompt at 0.22 tokens/char is not flagged", () => {
    // At a flat 0.75 per non-ASCII character this would read ~0.31 and be blocked forever.
    const delta = CYRILLIC_TEXT.repeat(1352); // ~50,000 characters
    const estimate = estimatePromptTokensForTruncation(systemPrompt) + estimatePromptTokensForTruncation(delta);
    const reported = Math.round(systemReal + 0.22 * delta.length);
    expect(reported / estimate).toBeGreaterThan(0.5);
    expect(detectPromptTruncation(estimate, reported)).toBe(false);
  });
});

describe("the model client uses the script-aware estimate", () => {
  test("refuses a CJK session log that a 4096-token Ollama window truncated", async () => {
    stubTokenizingServer(4096, { dense: 0.65, other: 0.3 }); // Qwen2.5-like rates
    const client = new OpenRouterMemoryModelClient();
    await expect(
      client.processMemory({ rawMemory: CJK_TEXT.repeat(600), config: ollamaConfig(), reason: "test" })
    ).rejects.toThrow(/truncated[\s\S]*num_ctx/i);
  });

  test("accepts the same CJK log when the window is large enough, even on an efficient tokenizer", async () => {
    stubTokenizingServer(131072, { dense: 0.45, other: 0.22 });
    const client = new OpenRouterMemoryModelClient();
    const res = await client.processMemory({ rawMemory: CJK_TEXT.repeat(2500), config: ollamaConfig(), reason: "test" });
    expect(res.content).toContain("summary");
  });

  test("accepts an untruncated Cyrillic log on an efficient tokenizer", async () => {
    stubTokenizingServer(131072, { dense: 0.45, other: 0.22 });
    const client = new OpenRouterMemoryModelClient();
    const res = await client.processMemory({ rawMemory: CYRILLIC_TEXT.repeat(1352), config: ollamaConfig(), reason: "test" });
    expect(res.content).toContain("summary");
  });
});
