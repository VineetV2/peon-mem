import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

describe("Peon daemon", () => {
  let daemon: PeonDaemonHandle;
  let projectPath: string;
  let logDir: string;
  let globalMemoryDir: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "peon-daemon-test-"));
    logDir = await mkdtemp(join(tmpdir(), "peon-daemon-logs-"));
    globalMemoryDir = await mkdtemp(join(tmpdir(), "peon-daemon-global-"));
    daemon = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir, globalMemoryDir });
  });

  afterEach(async () => {
    await daemon.close();
  });

  test("rejects cross-origin requests but allows loopback (Host/Origin guard)", async () => {
    const evil = await fetch(`${daemon.url}/health`, { headers: { origin: "http://evil.example.com" } });
    expect(evil.status).toBe(403);
    const ok = await fetch(`${daemon.url}/health`, { headers: { origin: daemon.url } });
    expect(ok.status).toBe(200);
  });

  test("ending an unknown session degrades to 200 (a SessionEnd hook must never 500)", async () => {
    // After a daemon restart an in-flight session id is no longer known; the SessionEnd
    // hook still POSTs /end. That must not 500 (it would surface as a hook error and break
    // the user's Claude session) — it degrades to a benign no-op.
    const response = await fetch(`${daemon.url}/sessions/does-not-exist-123/end`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: "does-not-exist-123", status: "unknown_session" });
  });

  test("reports health and active sessions over localhost HTTP", async () => {
    const health = await fetch(`${daemon.url}/health`).then((response) => response.json());
    expect(health).toMatchObject({
      ok: true,
      service: "peon-daemon"
    });

    const sessionsBefore = await fetch(`${daemon.url}/sessions`).then((response) => response.json());
    expect(sessionsBefore).toMatchObject({ active: [] });

    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "daemon-test"
    });

    const sessionsAfter = await fetch(`${daemon.url}/sessions`).then((response) => response.json());
    expect(sessionsAfter.active).toEqual([
      expect.objectContaining({
        id: started.sessionId,
        projectPath,
        client: "daemon-test"
      })
    ]);
  });

  test("records memory through HTTP and returns project context", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "daemon-test"
    });

    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "Peon daemon should record raw session memory."
    });
    await postJson(`${daemon.url}/events`, {
      sessionId: started.sessionId,
      type: "decision",
      content: "Peon local daemon is the owner of memory writes."
    });
    await postJson(`${daemon.url}/sessions/${started.sessionId}/end`, {});

    const context = await fetch(
      `${daemon.url}/context?projectPath=${encodeURIComponent(projectPath)}&query=daemon`
    ).then((response) => response.json());

    // Message appears in timeline; summary is AI-only until processor runs
    expect(context.timeline).toContain("Peon daemon should record raw session memory.");
    expect(context.decisions).toContain("Peon local daemon is the owner of memory writes.");

    const rawMessages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(rawMessages).toContain("Peon daemon should record raw session memory.");
  });

  test("processes project memory through HTTP when AI output is supplied", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "daemon-process-test"
    });

    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "Decision: Peon should process memory only behind explicit cost gates."
    });
    await postJson(`${daemon.url}/sessions/${started.sessionId}/end`, {});

    const processed = await postJson<{ status: string; model: string }>(`${daemon.url}/process`, {
      projectPath,
      reason: "manual-test",
      aiResult: {
        summary: "Peon daemon can process raw memory into structured brain files.",
        decisions: ["Only process memory behind explicit cost gates."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: ["Processed daemon memory."]
      }
    });

    expect(processed).toMatchObject({
      status: "processed",
      model: "manual-ai-result"
    });

    const decisions = await readFile(join(projectPath, ".peon/brain/decisions.md"), "utf8");
    expect(decisions).toContain("Only process memory behind explicit cost gates.");
  });

  test("records automatic processing decisions on session end without making silly calls", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "auto-policy-test"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "Short automatic processing policy note."
    });

    const ended = await postJson<{ autoProcessing: { status: string; decision: { reason: string; trigger: string } } }>(
      `${daemon.url}/sessions/${started.sessionId}/end`,
      {}
    );

    expect(ended.autoProcessing).toMatchObject({
      status: "skipped",
      decision: {
        reason: "below_threshold",
        trigger: "session_end"
      }
    });

    const state = await fetch(`${daemon.url}/monitor/state`).then((response) => response.json());
    expect(state.processingJobs).toEqual([
      expect.objectContaining({
        projectPath,
        status: "skipped",
        reason: "auto:session_end:below_threshold"
      })
    ]);
  });

  test("serves monitor HTML and state for active sessions and processing jobs", async () => {
    const htmlResponse = await fetch(`${daemon.url}/monitor`);
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("PEON // NEURAL HUD");
    // The cockpit IA: global Brain home, Projects drill-down, Ops.
    expect(html).toContain('href="#/brain"');
    expect(html).toContain('href="#/projects"');
    expect(html).toContain('href="#/ops"');
    // The Brain home: global memory + live autonomous activity.
    expect(html).toContain("Neural Core");
    expect(html).toContain("Global memory");
    expect(html).toContain("what the brain is doing");
    // Project insights drill-down + editable memory.
    expect(html).toContain("what Peon injected into your last prompt");
    expect(html).toContain("Uplink Preview");
    // Live popups + the animated brain.
    expect(html).toContain("brainviz");
    expect(html).toContain("/brain/activity");
    // Ops merges cost + activity.
    expect(html).toContain("Cost gate");
    expect(html).toContain("token A/B monitor");
    expect(html).toContain("/monitor/state");
    expect(html).toContain("/global/dashboard");
    expect(html).toContain("/network");
    expect(html).toContain("/memory/update");
    expect(html).toContain("/search");

    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "monitor-test"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "Monitor should show recent memory traffic."
    });
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "monitor-test",
      aiResult: {
        summary: "Monitor state includes processing jobs.",
        decisions: ["Build Peon Monitor."],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: []
      }
    });

    const state = await fetch(`${daemon.url}/monitor/state`).then((response) => response.json());
    expect(state).toMatchObject({
      service: "peon-daemon",
      activeSessions: [
        expect.objectContaining({
          id: started.sessionId,
          client: "monitor-test"
        })
      ],
      projects: [
        expect.objectContaining({
          projectPath,
          context: expect.objectContaining({
            summary: expect.stringContaining("Monitor state includes processing jobs."),
            decisions: expect.stringContaining("Build Peon Monitor.")
          }),
          brain: expect.objectContaining({
            records: expect.arrayContaining([
              expect.objectContaining({
                type: "decision",
                content: "Build Peon Monitor."
              })
            ]),
            graph: expect.objectContaining({
              nodes: expect.any(Array),
              edges: expect.any(Array)
            }),
            injectionPreview: expect.stringContaining("Structured Memory")
          })
        })
      ],
      processingJobs: [
        expect.objectContaining({
          projectPath,
          status: "processed",
          model: "manual-ai-result"
        })
      ]
    });
  });

  test("keeps monitored projects after daemon restart", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "registry-test"
    });
    await postJson(`${daemon.url}/sessions/${started.sessionId}/end`, {});

    await daemon.close();
    daemon = await startPeonDaemon({ host: "127.0.0.1", port: 0, logDir });

    const state = await fetch(`${daemon.url}/monitor/state`).then((response) => response.json());
    expect(state.projects).toEqual([
      expect.objectContaining({
        projectPath
      })
    ]);
  });

  test("serves structured brain records, graph, and injection preview", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "brain-test"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "We are building a local-first memory brain."
    });
    await postJson(`${daemon.url}/sessions/${started.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "brain-test",
      aiResult: {
        summary: "Peon is a local-first memory brain.",
        decisions: ["Represent memory as scored records."],
        preferences: ["Keep prompt-time retrieval local."],
        openQuestions: [],
        artifacts: ["peon-mcp/src/memory-store.ts"],
        timeline: ["Added structured memory records."]
      }
    });

    const brain = await fetch(
      `${daemon.url}/brain?projectPath=${encodeURIComponent(projectPath)}&query=${encodeURIComponent("scored memory records")}`
    ).then((response) => response.json());

    expect(brain).toMatchObject({
      projectPath,
      records: expect.arrayContaining([
        expect.objectContaining({
          type: "decision",
          content: "Represent memory as scored records.",
          score: expect.objectContaining({ importance: expect.any(Number) })
        })
      ]),
      graph: expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ type: "decision", label: "Represent memory as scored records." })
        ]),
        edges: expect.arrayContaining([expect.objectContaining({ type: "contains" })])
      }),
      injectionPreview: expect.stringContaining("Structured Memory")
    });
  });

  test("serves search, quality, global memory, and evaluation endpoints", async () => {
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "surface-test",
      aiResult: {
        summary: "Surface test summary.",
        decisions: ["Route StripeWebhook retries through src/payments/webhook.ts."],
        preferences: [],
        openQuestions: [],
        artifacts: ["src/payments/webhook.ts"],
        timeline: [],
        memories: [
          {
            type: "preference",
            content: "Across projects, keep status updates concise.",
            scope: "global",
            entities: ["user"]
          }
        ]
      }
    });

    const search = await fetch(
      `${daemon.url}/search?projectPath=${encodeURIComponent(projectPath)}&query=${encodeURIComponent("StripeWebhook src/payments/webhook.ts")}`
    ).then((response) => response.json());
    expect(search).toMatchObject({
      projectPath,
      records: expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ content: expect.stringContaining("StripeWebhook") }),
          explanation: expect.stringContaining("matched")
        })
      ]),
      injectionPreview: expect.stringContaining("Peon Search Results")
    });

    const quality = await fetch(`${daemon.url}/quality?projectPath=${encodeURIComponent(projectPath)}`).then((response) =>
      response.json()
    );
    expect(quality.inputCount).toBeGreaterThan(0);

    await postJson(`${daemon.url}/global/memories`, {
      memory: {
        type: "preference",
        content: "Use concise final responses.",
        scope: "global"
      }
    });
    const imported = await postJson<unknown[]>(`${daemon.url}/global/import-project`, { projectPath });
    const global = await fetch(`${daemon.url}/global/memories?query=concise`).then((response) => response.json());

    expect(imported).toEqual([
      expect.objectContaining({
        content: "Across projects, keep status updates concise."
      })
    ]);
    expect(global).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Use concise final responses." }),
        expect.objectContaining({ content: "Across projects, keep status updates concise." })
      ])
    );

    const evaluation = await postJson<{ recall: number; costSummary: { jobCount: number } }>(`${daemon.url}/evaluate`, {
      projectPath,
      expectedMemories: ["Route StripeWebhook retries through src/payments/webhook.ts."]
    });

    expect(evaluation.recall).toBe(1);
    expect(evaluation.costSummary.jobCount).toBeGreaterThanOrEqual(1);
  });

  test("logs incoming requests, outgoing responses, and processing jobs", async () => {
    const started = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "logging-test"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: started.sessionId,
      role: "user",
      content: "Logging test message."
    });
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "logging-test",
      aiResult: {
        summary: "Logging test summary.",
        decisions: [],
        preferences: [],
        openQuestions: [],
        artifacts: [],
        timeline: []
      }
    });

    const logText = await readFile(join(logDir, "daemon.jsonl"), "utf8");
    const entries = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "request_in", method: "POST", path: "/sessions" }),
        expect.objectContaining({ type: "response_out", method: "POST", path: "/sessions", status: 201 }),
        expect.objectContaining({ type: "process_start", projectPath, reason: "logging-test" }),
        expect.objectContaining({ type: "process_finish", projectPath, status: "processed" })
      ])
    );

    const logs = await fetch(`${daemon.url}/logs`).then((response) => response.json());
    expect(logs.entries.length).toBeGreaterThan(0);
    expect(logs.entries[0]).toEqual(expect.objectContaining({ type: expect.any(String) }));
  });
});
