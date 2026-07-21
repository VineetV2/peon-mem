import { describe, expect, it } from "vitest";
import { canonicalizeEntity, resolveEntities, inferCanonicalEntities } from "../src/entities.js";

describe("canonicalizeEntity", () => {
  it("collapses the 7 surface forms of one file to a single canonical key", () => {
    const forms = [
      "src/daemon.ts",
      "peon-mcp/src/daemon.ts",
      "/Users/vora/Documents/Project_x 2/peon-mcp/src/daemon.ts",
      "2/peon-mcp/src/daemon.ts", // the phantom from the space in "Project_x 2"
      "Project_x 2/.claude/worktrees/kind-haslett/peon-mcp/src/daemon.ts",
      "./src/daemon.ts",
      "peon-mcp\\src\\daemon.ts"
    ];
    const keys = new Set(forms.map((f) => canonicalizeEntity(f)?.key));
    expect([...keys]).toEqual(["src/daemon.ts"]);
  });

  it("never produces a phantom '2/...' node", () => {
    const c = canonicalizeEntity("2/peon-mcp/src/daemon.ts");
    expect(c?.key).toBe("src/daemon.ts");
    expect(c?.key.startsWith("2/")).toBe(false);
  });

  it("classifies files as code namespace", () => {
    expect(canonicalizeEntity("src/retrieval.ts")).toMatchObject({ kind: "file", namespace: "code" });
  });

  it("classifies code symbols vs domain concepts", () => {
    expect(canonicalizeEntity("rankMemoryRecords")).toMatchObject({ kind: "symbol", namespace: "code" });
    expect(canonicalizeEntity("Professor Shantanu Sharma")).toMatchObject({ kind: "concept", namespace: "domain" });
  });

  it("drops junk", () => {
    expect(canonicalizeEntity("")).toBeNull();
    expect(canonicalizeEntity("a")).toBeNull();
  });

  it("does NOT eat real numeric directory segments (regression: leading-digit strip)", () => {
    expect(canonicalizeEntity("2024/notes.md")?.key).toBe("2024/notes.md");
    expect(canonicalizeEntity("2024/01/notes.md")?.key).toBe("01/notes.md"); // parent/basename kept
    // but the genuine "Project_x 2" phantom still collapses via the src-root slice
    expect(canonicalizeEntity("2/peon-mcp/src/daemon.ts")?.key).toBe("src/daemon.ts");
  });

  it("unifies a product/acronym across backtick and prose forms (regression: dual node)", () => {
    // backtick `MaskSQL` and prose "MaskSQL" must canonicalize to the SAME domain key
    expect(canonicalizeEntity("MaskSQL")).toMatchObject({ key: "masksql", namespace: "domain" });
    expect(canonicalizeEntity("BIRD")).toMatchObject({ key: "bird", namespace: "domain" });
    // a lowercase-initial camelCase identifier stays a code symbol
    expect(canonicalizeEntity("rankMemoryRecords")).toMatchObject({ kind: "symbol", namespace: "code" });
  });
});

describe("resolveEntities", () => {
  it("extracts + dedupes file paths and backtick spans from content, canonicalized", () => {
    const content = "Edited `rankMemoryRecords` in /Users/vora/Documents/Project_x 2/peon-mcp/src/retrieval.ts and also src/retrieval.ts.";
    const keys = resolveEntities(content).map((e) => e.key);
    expect(keys).toContain("src/retrieval.ts");
    expect(keys.filter((k) => k === "src/retrieval.ts").length).toBe(1); // deduped
    expect(keys).toContain("rankMemoryRecords");
  });

  it("extracts domain entities (products/acronyms/proper nouns) from prose, namespaced domain", () => {
    const ents = resolveEntities("Discuss MaskSQL and the privacy idea with Shantanu Sharma; AskData hits 74% on BIRD vs OmniSQL.");
    const domain = ents.filter((e) => e.namespace === "domain").map((e) => e.key);
    expect(domain).toContain("masksql");
    expect(domain).toContain("bird");
    expect(domain).toContain("omnisql");
    expect(domain).toContain("shantanu sharma");
    // sentence-initial common words are NOT entities
    expect(domain).not.toContain("discuss");
  });

  it("inferCanonicalEntities returns canonical keys for the entities field", () => {
    const keys = inferCanonicalEntities("see peon-mcp/src/daemon.ts", ["src/daemon.ts"]);
    expect(keys).toEqual(["src/daemon.ts"]); // model-supplied + content-extracted collapse to one
  });
});
