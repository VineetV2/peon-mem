import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PeonMemoryStore } from "../src/memory-store.js";
import { PeonMemoryProcessor } from "../src/processor.js";

/**
 * FIDELITY-GAP GUARDRAIL (hermetic, zero-LLM).
 *
 * Peon's most important measured quality fact (LongMemEval): consolidation is a LOSSY gist —
 * belief-only recall 16.7% vs raw 61.1% — and the EPISODIC layer is what compensates, recovering
 * verbatim specifics (the "professor's 3 ideas" case). Nothing pinned that compensation, so a
 * retrieval/consolidation change could silently degrade it. This fixture reproduces the shape:
 * a session holds distinctive verbatim facts; consolidation (simulated exactly as the model
 * behaves: gist WITHOUT the specifics) drops them; getContext must STILL surface the verbatim
 * detail via episodes. If this fails, the fidelity compensation broke — do not ship.
 */

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("fidelity gap: episodic layer recovers what consolidation loses", () => {
  it("verbatim session detail survives a lossy consolidation and is served by getContext", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-fidelity-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });

    // The verbatim source of truth — three specific, named ideas.
    await store.recordMessage({
      sessionId: session.id,
      role: "user",
      content:
        "The professor suggested three ideas: (1) zorbal-hash partition pruning, (2) crellium join reordering, (3) a two-pass veltrace verifier."
    });
    await store.endSession({ sessionId: session.id });

    // Lossy consolidation — the gist the model actually produces (no idea names).
    const processor = new PeonMemoryProcessor();
    await processor.processMemory({
      projectPath,
      reason: "fidelity-fixture",
      aiResult: {
        summary: "Met the professor; discussed several optimization ideas for the pipeline.",
        decisions: ["Evaluate the professor's optimization suggestions."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: ["Professor meeting about optimization ideas."]
      }
    });

    // Belief layer alone must NOT contain the specifics (that's the measured lossiness)…
    const beliefs = await store.listMemoryRecords();
    expect(beliefs.some((r) => r.content.includes("zorbal-hash"))).toBe(false);

    // …but the INJECTION must still recover the verbatim detail via the episodic layer.
    const ctx = await store.getContext({ query: "what were the professor's three ideas", maxChars: 9000 });
    const served = JSON.stringify(ctx);
    expect(served).toContain("zorbal-hash");
    expect(served).toContain("crellium");
    expect(served).toContain("veltrace");
  });

  it("episodes stay OFF when explicitly opted out (belief-only callers unaffected)", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-fidelity-"));
    dirs.push(projectPath);
    const store = await PeonMemoryStore.open({ projectPath });
    const session = await store.startSession({ client: "claude-code", cwd: projectPath });
    await store.recordMessage({ sessionId: session.id, role: "user", content: "Idea: zorbal-hash pruning." });
    const ctx = await store.getContext({ query: "zorbal-hash", includeEpisodes: false, maxChars: 9000 });
    expect(ctx.episodes ?? "").toBe("");
  });
});
