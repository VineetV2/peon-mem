import { describe, expect, it } from "vitest";
import { buildContextInjection } from "../src/injection.js";
import type { RankedMemoryRecord } from "../src/retrieval.js";
import type { MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from "../src/types.js";

const now = "2026-06-01T00:00:00.000Z";

function memory(input: {
  id: string;
  type: MemoryType;
  content: string;
  scope: MemoryScope;
  status?: MemoryStatus;
  importance?: number;
  confidence?: number;
  entities?: string[];
  sourceReason?: string;
  updatedAt?: string;
}): MemoryRecord {
  return {
    id: input.id,
    type: input.type,
    content: input.content,
    normalized: input.content.toLowerCase(),
    scope: input.scope,
    status: input.status ?? "active",
    score: {
      importance: input.importance ?? 0.7,
      confidence: input.confidence ?? 0.8
    },
    source: {
      kind: "manual",
      reason: input.sourceReason
    },
    entities: input.entities ?? [],
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-05-30T00:00:00.000Z"
  };
}

function ranked(record: MemoryRecord, score: number, explanation: string): RankedMemoryRecord {
  return {
    record,
    score,
    explanation,
    reasons: [
      {
        kind: "query_term",
        label: explanation,
        score
      }
    ]
  };
}

describe("Context Injection v2", () => {
  it("blends project search results with global memory records and explains why each record was selected", () => {
    const project = ranked(
      memory({
        id: "project-decision",
        type: "decision",
        content: "Use durable queue retries for Stripe webhooks. API_KEY=sk_live_project_secret",
        scope: "project"
      }),
      0.05,
      "matched query terms stripe, webhooks"
    );
    const global = memory({
      id: "global-preference",
      type: "preference",
      content: "Prefer concise implementation summaries for MCP work. token: ghp_global_secret",
      scope: "global",
      importance: 0.95,
      confidence: 0.9,
      entities: ["MCP"]
    });

    const result = buildContextInjection({
      projectResults: [project],
      globalRecords: [global],
      query: "MCP stripe webhooks",
      maxChars: 1000,
      now
    });

    expect(result.preview).toContain("Peon Context Injection v2");
    expect(result.preview).toContain("[project:decision] Use durable queue retries for Stripe webhooks. API_KEY=[REDACTED]");
    expect(result.preview).toContain("[global:preference] Prefer concise implementation summaries for MCP work. token: [REDACTED]");
    expect(result.preview).toContain("why: matched query terms stripe, webhooks");
    expect(result.preview).toContain("why: matched query terms mcp");
    expect(result.preview).not.toContain("sk_live_project_secret");
    expect(result.preview).not.toContain("ghp_global_secret");
    expect(result.selected.map((item) => item.id)).toEqual(["global-preference", "project-decision"]);
    expect(result.selected[0]).toMatchObject({
      id: "global-preference",
      scope: "global",
      type: "preference",
      status: "active",
      whySelected: expect.stringContaining("matched query terms mcp")
    });
  });

  it("suppresses stale and conflicted records unless explicitly allowed", () => {
    const activeProject = ranked(
      memory({
        id: "active-project",
        type: "fact",
        content: "Active webhook route is src/webhook.ts.",
        scope: "project"
      }),
      5,
      "matched query terms webhook"
    );
    const staleGlobal = memory({
      id: "stale-global",
      type: "preference",
      content: "Stale webhook preference.",
      scope: "global",
      status: "stale"
    });
    const conflictedProject = ranked(
      memory({
        id: "conflicted-project",
        type: "decision",
        content: "Conflicted webhook decision.",
        scope: "project",
        status: "conflicted"
      }),
      10,
      "matched query terms webhook"
    );

    const defaultResult = buildContextInjection({
      projectResults: [activeProject, conflictedProject],
      globalRecords: [staleGlobal],
      query: "webhook",
      maxChars: 1000,
      now
    });

    expect(defaultResult.selected.map((item) => item.id)).toEqual(["active-project"]);
    expect(defaultResult.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "conflicted-project", reason: "suppressed_status" }),
        expect.objectContaining({ id: "stale-global", reason: "suppressed_status" })
      ])
    );

    const allowedResult = buildContextInjection({
      projectResults: [activeProject, conflictedProject],
      globalRecords: [staleGlobal],
      query: "webhook",
      maxChars: 1000,
      includeInactive: true,
      now
    });

    expect(allowedResult.selected.map((item) => item.id)).toEqual([
      "conflicted-project",
      "active-project",
      "stale-global"
    ]);
    expect(allowedResult.preview).toContain("status: conflicted");
    expect(allowedResult.preview).toContain("status: stale");
  });

  it("redacts a broad set of secret formats from the injected preview", () => {
    const secrets = [
      "key sk-ant-api03-AAAABBBBCCCCDDDDEEEE",
      "openai sk-proj-ABCDEFGHIJKLMNOPQRSTUV",
      "aws AKIAIOSFODNN7EXAMPLE",
      "google AIzaSyA1234567890abcdefghijklmnopqrstu",
      "jwt eyJhbGciOiJIUzI1NiI.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4",
      "auth Bearer abcdef1234567890ghijkl",
      "env MY_API_KEY=supersecretvalue123"
    ].join(" ");
    const result = buildContextInjection({
      projectResults: [ranked(memory({ id: "s", type: "fact", content: secrets, scope: "project" }), 0.1, "x")],
      globalRecords: [],
      query: "key",
      maxChars: 2000,
      now
    });
    for (const leak of ["sk-ant-api03-AAAA", "sk-proj-ABCDEF", "AKIAIOSFODNN7EXAMPLE", "AIzaSyA1234567890abcdef", "SflKxwRJSMeKKF2QT4", "supersecretvalue123"]) {
      expect(result.preview).not.toContain(leak);
    }
  });

  it("enforces maxChars against the final preview and metadata reflects only selected records", () => {
    const keep = ranked(
      memory({
        id: "keep",
        type: "decision",
        content: "Keep this compact payment memory.",
        scope: "project"
      }),
      8,
      "matched query terms payment"
    );
    const tooLarge = ranked(
      memory({
        id: "too-large",
        type: "artifact",
        content: "payment ".repeat(80),
        scope: "project"
      }),
      7,
      "matched query terms payment"
    );

    const result = buildContextInjection({
      projectResults: [keep, tooLarge],
      globalRecords: [],
      query: "payment",
      maxChars: 180,
      now
    });

    expect(result.preview.length).toBeLessThanOrEqual(180);
    expect(result.preview).toContain("Keep this compact payment memory.");
    expect(result.preview).not.toContain("payment payment payment payment");
    expect(result.selected.map((item) => item.id)).toEqual(["keep"]);
    expect(result.omitted).toEqual([expect.objectContaining({ id: "too-large", reason: "max_chars" })]);
    expect(result.totalChars).toBe(result.preview.length);
  });
});
