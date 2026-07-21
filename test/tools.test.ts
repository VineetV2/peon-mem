import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPeonTools } from "../src/tools.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Peon MCP tool handlers", () => {
  it("starts a session, records memory, ends the session, and returns project context", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-tools-"));
    dirs.push(projectPath);
    const tools = createPeonTools();

    const started = await tools.startSession({ projectPath, client: "claude" });
    await tools.recordMessage({ sessionId: started.sessionId, role: "user", content: "Preference: keep processing cheap and local-first." });
    await tools.recordEvent({ sessionId: started.sessionId, type: "preference", content: "Keep processing cheap and local-first." });
    await tools.endSession({ sessionId: started.sessionId });

    const context = await tools.getContext({ projectPath, query: "preferences" });

    expect(context.preferences).toContain("Keep processing cheap and local-first.");
  });

  it("processes memory with a supplied AI result", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-tools-process-"));
    dirs.push(projectPath);
    const tools = createPeonTools();

    const started = await tools.startSession({ projectPath, client: "claude" });
    await tools.recordMessage({ sessionId: started.sessionId, role: "user", content: "Decision: build Peon daemon first." });
    await tools.endSession({ sessionId: started.sessionId });

    const result = await tools.processMemory({
      projectPath,
      reason: "manual-test",
      aiResult: {
        summary: "Peon now has a daemon-first architecture.",
        decisions: ["Build Peon daemon first."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: []
      }
    });

    expect(result.status).toBe("processed");
    const context = await tools.getContext({ projectPath, query: "daemon-first" });
    expect(context.summary).toContain("daemon-first architecture");
    expect(context.decisions).toContain("Build Peon daemon first.");
  });

  it("searches structured memory with ranked explanations and a context budget", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-tools-search-"));
    dirs.push(projectPath);
    const tools = createPeonTools();

    await tools.processMemory({
      projectPath,
      reason: "search-test",
      aiResult: {
        summary: "Searchable project memory.",
        decisions: ["Route StripeWebhook retries through src/payments/webhook.ts."],
        preferences: ["Keep webhook processing local-first."],
        openQuestions: [],
        artifacts: ["src/payments/webhook.ts"],
        timeline: []
      }
    });

    const result = await tools.searchMemory({
      projectPath,
      query: "StripeWebhook src/payments/webhook.ts",
      maxChars: 500
    });

    expect(result.records[0]).toEqual(
      expect.objectContaining({
        record: expect.objectContaining({
          content: expect.stringContaining("StripeWebhook")
        }),
        explanation: expect.stringContaining("matched")
      })
    );
    expect(result.selected.totalChars).toBeLessThanOrEqual(500);
    expect(result.injectionPreview).toContain("Peon Search Results");
  });

  it("builds a redacted context injection from project and global memory", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-tools-injection-"));
    const globalMemoryDir = mkdtempSync(join(tmpdir(), "peon-tools-injection-global-"));
    dirs.push(projectPath, globalMemoryDir);
    const tools = createPeonTools({ globalMemoryDir });

    await tools.processMemory({
      projectPath,
      reason: "injection-test",
      aiResult: {
        summary: "Injection project memory.",
        decisions: ["Use StripeWebhook retries with API_KEY=sk_live_projectsecret."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: []
      }
    });
    await tools.rememberGlobal({
      memory: {
        type: "preference",
        content: "Prefer concise MCP updates with token: ghp_secretvalue123.",
        scope: "global",
        entities: ["MCP"]
      }
    });

    const injection = await tools.buildInjection({
      projectPath,
      query: "StripeWebhook MCP",
      maxChars: 1200
    });

    expect(injection.preview).toContain("Peon Context Injection v2");
    expect(injection.preview).toContain("why:");
    expect(injection.preview).toContain("[REDACTED]");
    expect(injection.preview).not.toContain("sk_live_projectsecret");
    expect(injection.preview).not.toContain("ghp_secretvalue123");
    expect(injection.selected.map((item) => item.scope)).toEqual(expect.arrayContaining(["project", "global"]));
  });

  it("reports memory quality, manages global memory, imports global-scoped records, and evaluates projects", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "peon-tools-quality-"));
    const globalMemoryDir = mkdtempSync(join(tmpdir(), "peon-tools-global-"));
    dirs.push(projectPath, globalMemoryDir);
    const tools = createPeonTools({ globalMemoryDir });

    await tools.processMemory({
      projectPath,
      reason: "integration-test",
      aiResult: {
        summary: "Peon integration memory.",
        decisions: ["Docker is enabled for tests.", "Docker is disabled for tests."],
        preferences: ["Prefer concise status updates."],
        openQuestions: [],
        artifacts: [],
        timeline: [],
        memories: [
          {
            type: "preference",
            content: "Across projects, prefer concise status updates.",
            scope: "global",
            entities: ["user"]
          }
        ]
      }
    });

    const quality = await tools.qualityReport({ projectPath });
    expect(quality.inputCount).toBeGreaterThan(0);
    expect(quality.outputCount).toBeGreaterThan(0);

    await tools.rememberGlobal({
      memory: {
        type: "preference",
        content: "Use concise final responses.",
        scope: "global",
        entities: ["response-style"]
      }
    });
    const imported = await tools.importGlobalMemory({ projectPath });
    const global = await tools.searchGlobalMemory({ query: "concise" });

    expect(imported).toEqual([
      expect.objectContaining({
        scope: "global",
        content: "Across projects, prefer concise status updates."
      })
    ]);
    expect(global.map((record) => record.content)).toEqual(
      expect.arrayContaining(["Use concise final responses.", "Across projects, prefer concise status updates."])
    );

    const evaluation = await tools.evaluateProject({
      projectPath,
      expectedMemories: ["Prefer concise status updates."]
    });

    expect(evaluation.recall).toBe(1);
    expect(evaluation.costSummary.jobCount).toBeGreaterThanOrEqual(1);
  });
});
