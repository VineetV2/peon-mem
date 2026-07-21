import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startPeonDaemon, type PeonDaemonHandle } from "../src/daemon.js";

describe("Claude Code Peon hook bridge", () => {
  let daemon: PeonDaemonHandle;
  let projectPath: string;
  let stateDir: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), "peon-claude-hook-project-"));
    stateDir = await mkdtemp(join(tmpdir(), "peon-claude-hook-state-"));
    daemon = await startPeonDaemon({
      host: "127.0.0.1",
      port: 0,
      // Isolated GLOBAL brain: hierarchical recall now injects global parent-brain hits, so the
      // test daemon must not read the user's real global memory (breaks the empty-project case).
      globalMemoryDir: mkdtempSync(join(tmpdir(), "peon-hook-global-"))
    });
  });

  afterEach(async () => {
    await daemon.close();
    await rm(projectPath, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  test("starts a session and records user prompts through hook input", async () => {
    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: "This is an automatic Peon hook test."
    });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("This is an automatic Peon hook test.");
  });

  test("prints compact Peon context on session start when project memory exists", async () => {
    const seedSession = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "seed"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: seedSession.sessionId,
      role: "user",
      content: "We are building an XO game with local commits on master."
    });
    await postJson(`${daemon.url}/sessions/${seedSession.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "test-seed",
      aiResult: {
        summary: "The project is an XO game committed locally on master.",
        decisions: ["Use vanilla HTML/CSS/JS for the XO game."],
        preferences: ["Keep the work local."],
        openQuestions: [],
        artifacts: ["index.html"],
        timeline: ["XO game implementation completed."]
      }
    });

    const stdout = await runHook({
      hook_event_name: "SessionStart",
      session_id: "test-session",
      cwd: projectPath
    });

    expect(stdout).toContain("Peon Context");
    expect(stdout).toContain("XO game");
    expect(stdout.length).toBeLessThan(7000);
  });

  test("accepts alternate hook event and session field names", async () => {
    await runHook({
      event_name: "UserPromptSubmit",
      sessionId: "test-session",
      project: { cwd: projectPath },
      message: { content: [{ type: "text", text: "Prompt from alternate fields." }] }
    });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("Prompt from alternate fields.");
  });

  test("prints prompt-relevant Peon memory when a user prompt is submitted", async () => {
    const seedSession = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "seed"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: seedSession.sessionId,
      role: "user",
      content: "We built an XO game in index.html and kept commits local on master."
    });
    await postJson(`${daemon.url}/sessions/${seedSession.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "test-seed",
      aiResult: {
        summary: "The project is an XO game built in index.html.",
        decisions: ["Keep commits local on master."],
        preferences: [],
        openQuestions: [],
        artifacts: ["index.html"],
        timeline: ["Completed the XO game."]
      }
    });

    const stdout = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: "what are we working here?"
    });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("what are we working here?");
    expect(stdout).toContain("Peon Relevant Memory");
    expect(stdout).toContain("XO game");
    expect(stdout.length).toBeLessThan(5000);
  });

  test("injects memory for an oversized prompt without a 431 on the /context request line", async () => {
    const seedSession = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, {
      projectPath,
      client: "seed"
    });
    await postJson(`${daemon.url}/messages`, {
      sessionId: seedSession.sessionId,
      role: "user",
      content: "We built an XO game in index.html and kept commits local on master."
    });
    await postJson(`${daemon.url}/sessions/${seedSession.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, {
      projectPath,
      reason: "test-seed",
      aiResult: {
        summary: "The project is an XO game built in index.html.",
        decisions: ["Keep commits local on master."],
        preferences: [],
        openQuestions: [],
        artifacts: ["index.html"],
        timeline: ["Completed the XO game."]
      }
    });

    // A prompt far larger than Node's ~16KB default max header size. Uncapped,
    // this would push the /context GET request line past the limit → HTTP 431 →
    // no memory injected. The query is still recognizable (XO game) at the head.
    const hugePrompt = `what are we working on with the XO game? ${"context ".repeat(4000)}`;
    expect(hugePrompt.length).toBeGreaterThan(20000);

    const stdout = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: hugePrompt
    });

    // Injection must survive the oversized prompt.
    expect(stdout).toContain("Peon Relevant Memory");
    expect(stdout).toContain("XO game");
    // The full prompt is still recorded (recording goes over a JSON POST body, not the URL).
    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("what are we working on with the XO game?");
  });

  test("does not echo a first prompt as relevant memory for an empty project", async () => {
    const stdout = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: "what are we doing?"
    });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("what are we doing?");
    expect(stdout).toBe("");
  });

  test("records tool activity and the assistant summary on stop", async () => {
    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: "Start working."
    });
    await runHook({
      hook_event_name: "PostToolUse",
      session_id: "test-session",
      cwd: projectPath,
      tool_name: "Bash",
      tool_input: { command: "pytest" },
      tool_response: { stdout: "1 passed" }
    });
    await runHook({
      hook_event_name: "Stop",
      session_id: "test-session",
      cwd: projectPath,
      last_assistant_message: "Finished the test."
    });

    const events = await readFile(join(projectPath, ".peon/raw/events.jsonl"), "utf8");
    expect(events).toContain("Tool used: Bash");
    expect(events).toContain("pytest");
    expect(events).toContain("Finished the test.");
    // Tool activity appears in timeline; project-summary.md is AI-only until processor runs
    const timeline = await readFile(join(projectPath, ".peon/brain/timeline.md"), "utf8");
    expect(timeline).toContain("Tool used: Bash");
  });

  test("keeps the session alive across Stop so multi-turn recording stays in ONE session", async () => {
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "multi-turn", cwd: projectPath, prompt: "Turn one." });
    await runHook({ hook_event_name: "Stop", session_id: "multi-turn", cwd: projectPath, last_assistant_message: "Did one." });
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "multi-turn", cwd: projectPath, prompt: "Turn two." });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("Turn one.");
    expect(messages).toContain("Turn two.");
    // Both turns must share ONE Peon session — Stop no longer fragments/ends it.
    const sessionIds = messages.trim().split(/\n/).map((line) => JSON.parse(line).sessionId);
    expect(new Set(sessionIds).size).toBe(1);
  });

  test("injects Peon memory into SubagentStart so workers don't redo work (the multi-agent fix)", async () => {
    // Seed memory in a DIFFERENT project than the subagent's cwd — proves cross-project recall.
    const otherProject = await mkdtemp(join(tmpdir(), "peon-other-proj-"));
    const seed = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, { projectPath: otherProject, client: "seed" });
    await postJson(`${daemon.url}/messages`, { sessionId: seed.sessionId, role: "user", content: "Extracted the schema linking method from the DTS-SQL paper: it filters tables in two stages." });
    await postJson(`${daemon.url}/sessions/${seed.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, {
      projectPath: otherProject, reason: "seed",
      aiResult: { summary: "DTS-SQL schema linking already extracted: two-stage table filtering.", decisions: [], preferences: [], openQuestions: [], artifacts: [], timeline: [] }
    });

    const stdout = await runHook({
      hook_event_name: "SubagentStart",
      cwd: projectPath, // the worker's own (empty) project
      prompt: "Extract the schema linking method from the DTS-SQL paper"
    });

    // The worker now receives structured additionalContext with the prior work.
    const out = JSON.parse(stdout);
    const ctx = out.hookSpecificOutput.additionalContext as string;
    expect(out.hookSpecificOutput.hookEventName).toBe("SubagentStart");
    expect(ctx).toContain("DTS-SQL schema linking already extracted");
    expect(ctx).toContain("don't redo it");
    await rm(otherProject, { recursive: true, force: true });
  });

  test("records subagent RESULTS on SubagentStop so worker findings aren't redone", async () => {
    await runHook({
      hook_event_name: "SubagentStop",
      cwd: projectPath,
      agent_type: "Explore",
      result: "Extracted schema linking from DTS-SQL: two-stage table filtering with a fine-tuned linker."
    });
    const events = await readFile(join(projectPath, ".peon/raw/events.jsonl"), "utf8");
    expect(events).toContain("subagent:Explore");
    expect(events).toContain("two-stage table filtering");
  });

  test("UserPromptExpansion injects Peon memory for slash-command/skill expansions", async () => {
    const seed = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, { projectPath, client: "seed" });
    await postJson(`${daemon.url}/messages`, { sessionId: seed.sessionId, role: "user", content: "We are building an XO game in index.html." });
    await postJson(`${daemon.url}/sessions/${seed.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, { projectPath, reason: "seed", aiResult: { summary: "XO game in index.html.", decisions: ["Keep it local."], preferences: [], openQuestions: [], artifacts: ["index.html"], timeline: [] } });

    const stdout = await runHook({ hook_event_name: "UserPromptExpansion", cwd: projectPath, command: "/explain what are we building" });
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion");
    expect(out.hookSpecificOutput.additionalContext).toContain("XO game");
  });

  test("PreToolUse surfaces memory before a WebSearch, and stays silent for non-web tools", async () => {
    const seed = await postJson<{ sessionId: string }>(`${daemon.url}/sessions`, { projectPath, client: "seed" });
    await postJson(`${daemon.url}/messages`, { sessionId: seed.sessionId, role: "user", content: "Already researched the DTS-SQL schema linking approach in depth." });
    await postJson(`${daemon.url}/sessions/${seed.sessionId}/end`, {});
    await postJson(`${daemon.url}/process`, { projectPath, reason: "seed", aiResult: { summary: "DTS-SQL schema linking already researched.", decisions: [], preferences: [], openQuestions: [], artifacts: [], timeline: [] } });

    const web = await runHook({ hook_event_name: "PreToolUse", cwd: projectPath, tool_name: "WebSearch", tool_input: { query: "DTS-SQL schema linking approach" } });
    expect(JSON.parse(web).hookSpecificOutput.additionalContext).toContain("reuse it");

    const bash = await runHook({ hook_event_name: "PreToolUse", cwd: projectPath, tool_name: "Bash", tool_input: { command: "ls" } });
    expect(bash).toBe(""); // non-web tools produce no output (no overhead/noise)
  });

  test("self-heals recording when the daemon has forgotten the session (restart)", async () => {
    // Turn 1 establishes the session + the hook's local cache.
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "heal-session", cwd: projectPath, prompt: "Before the restart." });
    // Simulate a daemon restart: end the session out-of-band so the daemon forgets it,
    // while the hook's cache still points at the now-dead session id.
    const cached = JSON.parse(await readFile(join(stateDir, "heal-session.json"), "utf8")) as { sessionId: string };
    await postJson(`${daemon.url}/sessions/${cached.sessionId}/end`, {});
    // The next prompt must still record — recordWithSession recreates + retries.
    await runHook({ hook_event_name: "UserPromptSubmit", session_id: "heal-session", cwd: projectPath, prompt: "After the restart." });

    const messages = await readFile(join(projectPath, ".peon/raw/messages.jsonl"), "utf8");
    expect(messages).toContain("Before the restart.");
    expect(messages).toContain("After the restart.");
  });

  test("records assistant summaries from nested stop payloads", async () => {
    await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "test-session",
      cwd: projectPath,
      prompt: "Start working."
    });
    await runHook({
      hook_event_name: "Stop",
      session_id: "test-session",
      cwd: projectPath,
      response: {
        message: {
          content: [
            { type: "text", text: "Implemented the reliable auto-capture hook foundation." },
            { type: "tool_use", name: "Bash" }
          ]
        }
      }
    });

    const events = await readFile(join(projectPath, ".peon/raw/events.jsonl"), "utf8");
    expect(events).toContain("assistant_summary");
    expect(events).toContain("Implemented the reliable auto-capture hook foundation.");
  });

  test("logs malformed hook input locally without failing the caller", async () => {
    const stdout = await runHookRaw("{not valid json", {
      daemonUrl: daemon.url,
      stateDir
    });

    expect(stdout).toBe("");
    const errors = await readFile(join(stateDir, "errors.jsonl"), "utf8");
    expect(errors).toContain("invalid_json");
    expect(errors).toContain("JSON");
  });

  test("logs daemon unavailability locally without failing the caller", async () => {
    const stdout = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "test-session",
        cwd: projectPath,
        prompt: "This should be preserved in the local error context."
      },
      { daemonUrl: "http://127.0.0.1:9" }
    );

    expect(stdout).toBe("");
    const errors = await readFile(join(stateDir, "errors.jsonl"), "utf8");
    expect(errors).toContain("UserPromptSubmit");
    expect(errors).toContain(projectPath);
    expect(errors).toContain("test-session");
  });

  async function runHook(input: unknown, options: { daemonUrl?: string } = {}): Promise<string> {
    return runHookRaw(JSON.stringify(input), {
      daemonUrl: options.daemonUrl ?? daemon.url,
      stateDir
    });
  }

  async function runHookRaw(rawInput: string, options: { daemonUrl: string; stateDir: string }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn("node", ["scripts/claude-peon-hook.mjs"], {
        cwd: "/Users/vora/Documents/Project_x 2/peon-mcp",
        env: {
          ...process.env,
          PEON_DAEMON_URL: options.daemonUrl,
          PEON_HOOK_STATE_DIR: options.stateDir
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Hook exited with code ${code}`));
      });
      child.stdin.end(rawInput);
    });
  }
});

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}
