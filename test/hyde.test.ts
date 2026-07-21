import { describe, expect, it, vi } from "vitest";
import { expandQuery } from "../src/hyde.js";
import type { FetchLike } from "../src/reranker.js";
import { loadPeonConfig } from "../src/config.js";

const config = { ...loadPeonConfig(), aiMode: "gated" as const, openRouterApiKey: "test-key" };

function mockFetch(content: string): FetchLike {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ choices: [{ message: { content } }] })
  }));
}

describe("expandQuery (HyDE)", () => {
  it("appends the hypothetical answer to the original query", async () => {
    const result = await expandQuery("how do we handle retries", {
      config,
      fetchImpl: mockFetch("Webhook retries route through the durable queue with exponential backoff.")
    });
    expect(result.hypothetical).toContain("durable queue");
    expect(result.expanded.startsWith("how do we handle retries")).toBe(true);
    expect(result.expanded).toContain("durable queue");
  });

  it("truncates an overlong hypothetical", async () => {
    const result = await expandQuery("q", { config, maxChars: 100, fetchImpl: mockFetch("x".repeat(500)) });
    expect(result.hypothetical.length).toBeLessThanOrEqual(100);
  });

  it("falls back to the original query on a failed response", async () => {
    const failing: FetchLike = vi.fn(async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) }));
    const result = await expandQuery("my query", { config, fetchImpl: failing });
    expect(result.expanded).toBe("my query");
    expect(result.hypothetical).toBe("");
  });

  it("does not call the model without an API key", async () => {
    const spy = vi.fn();
    const result = await expandQuery("q", { config: { ...config, openRouterApiKey: undefined }, fetchImpl: spy as unknown as FetchLike });
    expect(spy).not.toHaveBeenCalled();
    expect(result.expanded).toBe("q");
  });

  it("returns empty for an empty query", async () => {
    const spy = vi.fn();
    const result = await expandQuery("", { config, fetchImpl: spy as unknown as FetchLike });
    expect(spy).not.toHaveBeenCalled();
    expect(result).toEqual({ expanded: "", hypothetical: "" });
  });
});
