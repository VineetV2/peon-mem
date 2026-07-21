import { describe, expect, it, vi } from "vitest";
import { extractDomainEntitiesViaModel, parseEntityArray, type ExtractItem } from "../src/entity-extraction.js";
import type { FetchLike } from "../src/reranker.js";
import { loadPeonConfig } from "../src/config.js";

const config = { ...loadPeonConfig(), aiMode: "gated" as const, openRouterApiKey: "test-key" };
const mockFetch = (content: string): FetchLike =>
  vi.fn(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content } }] }) }));

const items: ExtractItem[] = [
  { key: "a", content: "Discuss MaskSQL with Shantanu Sharma." },
  { key: "b", content: "AskData scores 74% on BIRD." }
];

describe("parseEntityArray", () => {
  it("parses a JSON array of {n, entities}", () => {
    expect(parseEntityArray('[{"n":1,"entities":["MaskSQL","Shantanu Sharma"]},{"n":2,"entities":["BIRD"]}]')).toEqual([
      { n: 1, entities: ["MaskSQL", "Shantanu Sharma"] },
      { n: 2, entities: ["BIRD"] }
    ]);
  });
  it("tolerates surrounding prose and drops malformed rows (and single-char noise)", () => {
    // the {entities:[...]} row has no `n` → dropped; single-char "Y" is noise → filtered
    expect(parseEntityArray('here: [{"n":1,"entities":["Foo","Y"]}, {"entities":["Bar"]}] done')).toEqual([{ n: 1, entities: ["Foo"] }]);
  });
  it("returns [] on junk", () => {
    expect(parseEntityArray("no array")).toEqual([]);
  });
});

describe("extractDomainEntitiesViaModel", () => {
  it("maps model entities back to item keys by snippet number", async () => {
    const fetchImpl = mockFetch('[{"n":1,"entities":["MaskSQL","Shantanu Sharma"]},{"n":2,"entities":["BIRD","AskData"]}]');
    const out = await extractDomainEntitiesViaModel(items, { config, fetchImpl });
    expect(out.get("a")).toEqual(["MaskSQL", "Shantanu Sharma"]);
    expect(out.get("b")).toEqual(["BIRD", "AskData"]);
  });

  it("returns an empty map (no model call) without an API key", async () => {
    const spy = vi.fn();
    const out = await extractDomainEntitiesViaModel(items, { config: { ...config, openRouterApiKey: undefined }, fetchImpl: spy as unknown as FetchLike });
    expect(spy).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("degrades to an empty map on a failed response", async () => {
    const failing: FetchLike = vi.fn(async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) }));
    const out = await extractDomainEntitiesViaModel(items, { config, fetchImpl: failing });
    expect(out.size).toBe(0);
  });

  it("returns empty for empty input without calling the model", async () => {
    const spy = vi.fn();
    const out = await extractDomainEntitiesViaModel([], { config, fetchImpl: spy as unknown as FetchLike });
    expect(spy).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });
});
