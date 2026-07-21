#!/usr/bin/env node
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream as fsCreateReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// Hard off-switch (for A/B testing). When PEON_DISABLED is set, Peon does nothing —
// no injection, no recording, no daemon calls — EXCEPT counting the session's token
// usage on Stop/SessionEnd, because the OFF arm's whole purpose is to be the baseline
// in the token A/B comparison. (Handled inside the main block below.)
const PEON_OFF = /^(1|true|yes|on)$/i.test(process.env.PEON_DISABLED || "");

const daemonUrl = (process.env.PEON_DAEMON_URL || "http://127.0.0.1:3737").replace(/\/$/, "");
const stateDir =
  process.env.PEON_HOOK_STATE_DIR || join(homedir(), "Library", "Application Support", "Peon", "claude-hooks");
const hookClient = process.env.PEON_HOOK_CLIENT || "claude-code";

// Framing that makes injected memory authoritative — so the model consults it
// FIRST instead of defaulting to a web search or re-reading files. Without this,
// the memory is just passive context and gets ignored. Declared up here (not by
// the formatters) so it's initialized before the top-level await block runs.
const PEON_FIRST_DIRECTIVE =
  "<peon-memory>\nThis is your saved memory for THIS project and the user's environment, recalled automatically by Peon. " +
  "Treat it as AUTHORITATIVE and consult it FIRST. If it already answers what the user is asking — a PROCEDURE (how to " +
  "run/build/submit/deploy something), a past RESULT or number, a FILE PATH, or a DECISION/config — use that answer " +
  "directly and cite it. Do NOT re-run a command, re-submit or re-explore a cluster/job, re-read source, or re-derive " +
  "something JUST to rediscover what is already stated here (e.g. don't go re-inspect how to run an experiment the memory " +
  "already documents). Go to the source ONLY to genuinely verify when the memory is absent, stale, or the user explicitly " +
  "asks for fresh verification. For anything relevant not shown below, call the Peon `search_memory` tool before falling " +
  "back to reading code or re-running work. You do not need to be asked to use this memory.\n</peon-memory>";

// The retrieval query rides on the GET /context request line as a URL search
// param. A large user prompt (a pasted JD, a big code block) URL-encodes into a
// request line that overflows the daemon's Node http server default max header
// size (~16KB) → the server answers 431 before the handler runs, and injection
// silently fails. The first N chars are more than enough to rank retrieval, so
// cap at the single choke point getProjectContext (sibling callers already slice
// to 400/600, well under this). Declared up here — like PEON_FIRST_DIRECTIVE —
// so it is initialized before the top-level await block calls getProjectContext.
const MAX_CONTEXT_QUERY_CHARS = 2000;

// Token A/B ledger paths — declared BEFORE the top-level await block (everything the main
// block touches must be initialized first, or the reference throws a silent TDZ error;
// that exact bug made token tracking a no-op for weeks).
const TOKEN_AB_LOG = join(homedir(), "Library", "Application Support", "Peon", "token-ab-log.jsonl");
const TOKEN_AB_LOGGED_SESSIONS = join(homedir(), "Library", "Application Support", "Peon", "token-ab-sessions.json");

// Resolve any working directory to its ONE project brain, so memory never fragments:
//   1. collapse git-worktree paths to the repo root (…/.claude/worktrees/x → repo)
//   2. walk UP to the TOPMOST ancestor that already holds a Peon brain (.peon), bounded by
//      home. A project with no .git (e.g. "Master Project 700B") would otherwise spawn a
//      separate empty brain in every subfolder a session starts in — so working inside
//      Privacy_NL2SQL/ injected nothing while the real 1400+ belief brain sat at the root.
//      Topmost-.peon unifies all subfolders onto the root brain.
//   3. EXCEPT a `.peon/root` marker declares a brain BOUNDARY: the nearest one wins and the climb
//      stops there, so a big sub-project (e.g. a thesis folder) keeps its OWN brain. Must match
//      canonicalProjectPath() in src/daemon.ts so hook + direct-MCP + Codex all resolve identically.
function resolveProjectPath(p) {
  const marker = "/.claude/worktrees/";
  const idx = p.indexOf(marker);
  const base = idx !== -1 ? p.slice(0, idx) : p;
  const home = homedir();
  let dir = base;
  let rootBrain = null;
  while (dir && dir.startsWith(home) && dir !== home) {
    if (existsSync(join(dir, ".peon"))) {
      if (existsSync(join(dir, ".peon", "root"))) return dir; // boundary marker — its own brain
      rootBrain = dir; // otherwise topmost-wins
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return rootBrain || base;
}

let eventName = "unknown";
let projectPath = resolveProjectPath(process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_DIR || process.cwd());
let externalSessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || "unknown-session";

try {
  const input = await readStdinJson();
  eventName = normalizeEventName(readFirst(input, ["hook_event_name", "event_name", "eventName", "event", "name", "type"]));
  projectPath = resolveProjectPath(readText(input, [
    "cwd",
    "project.cwd",
    "workspace.cwd",
    "workspace_path",
    "workspacePath",
    "project_path",
    "projectPath"
  ]) || projectPath);
  externalSessionId =
    readText(input, ["session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"]) ||
    externalSessionId;

  if (PEON_OFF) {
    if (eventName === "Stop" || eventName === "SessionEnd") await trackTokenUsage(input, projectPath, externalSessionId);
    process.exit(0);
  }

  if (eventName === "SessionStart") {
    await ensurePeonSession({ projectPath, externalSessionId, client: hookClient });
    const context = await getProjectContext(projectPath, "recent project context decisions artifacts current work");
    const startupContext = formatStartupContext(context);
    if (startupContext) process.stdout.write(startupContext);
  } else if (eventName === "SubagentStart") {
    // Subagents DON'T fire SessionStart/UserPromptSubmit, so without this they start
    // blind and redo work already in memory (the multi-agent token-waste problem).
    // Give each worker the same Peon-first memory the main session gets — and pull
    // CROSS-project, since a worker may touch a paper that lives in another brain.
    const task = extractText(
      readFirst(input, ["prompt", "description", "task", "agent_prompt", "input", "message"])
    );
    const memory = await buildSubagentContext(task, projectPath);
    if (memory) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: memory } })
      );
    }
  } else if (eventName === "SubagentStop") {
    // Mirror of SubagentStart: capture what the worker PRODUCED so it's never redone.
    // Subagent tool-uses don't route to the main session, so this is the only place
    // their findings enter Peon.
    const result = extractText(
      readFirst(input, ["result", "output", "final_output", "response", "summary", "last_assistant_message", "message"])
    );
    const agentType = extractText(readFirst(input, ["agent_type", "subagent_type", "matcher", "name"]));
    if (result.trim()) {
      await recordWithSession({ projectPath, externalSessionId, client: hookClient }, (sessionId) =>
        postJson("/events", { sessionId, type: "assistant_summary", content: `[subagent${agentType ? ":" + agentType : ""}] ${result.slice(0, 2000)}` }));
      await postJson("/process/auto", { projectPath, trigger: "subagent_end" }).catch(() => undefined);
    }
  } else if (eventName === "PreToolUse") {
    // Only wired for WebSearch/WebFetch (matcher-scoped in settings). Before an
    // expensive web call, surface what Peon already knows so it isn't re-fetched.
    const toolName = extractText(readFirst(input, ["tool_name", "toolName", "tool.name", "tool", "name"]));
    const q = extractText(readFirst(input, ["tool_input.query", "tool_input.prompt", "tool_input.url", "input.query", "input.url", "query", "url"]))
      || summarize(readFirst(input, ["tool_input", "input", "arguments"]) || {});
    if (/^(WebSearch|WebFetch)$/i.test(toolName) && q.trim()) {
      const hits = await getCrossProjectRecall(q.slice(0, 400), null).catch(() => "");
      const local = await getProjectContext(projectPath, q.slice(0, 400)).then((c) => formatRelevantMemory(c)).catch(() => "");
      const note = [local, hits].filter(Boolean).join("\n\n");
      if (note) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Before searching the web, note Peon already has related memory — reuse it if it answers the need:\n${note}` }
        }));
      }
    }
  } else if (eventName === "UserPromptSubmit" || eventName === "UserPromptExpansion") {
    const prompt = extractText(readFirst(input, ["prompt", "message", "user_prompt", "userPrompt", "input", "expanded_prompt", "command"]));
    if (prompt.trim()) {
      const context = await getProjectContext(projectPath, prompt);
      const relevantMemory = formatRelevantMemory(context);
      if (relevantMemory) {
        // UserPromptExpansion expects structured additionalContext; UserPromptSubmit takes raw stdout.
        if (eventName === "UserPromptExpansion") {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: relevantMemory } }));
        } else {
          process.stdout.write(relevantMemory);
        }
      }
      await recordWithSession({ projectPath, externalSessionId, client: hookClient }, (sessionId) =>
        postJson("/messages", { sessionId, role: "user", content: prompt }));
    }
  } else if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") {
    await recordWithSession({ projectPath, externalSessionId, client: hookClient }, (sessionId) =>
      postJson("/events", { sessionId, type: "tool_use", content: formatToolUse(input) }));
  } else if (eventName === "Stop") {
    // A response TURN finished — capture the summary and let Peon consolidate,
    // but keep the session ALIVE. Stop fires after every turn; the Claude session
    // (and the Peon session) continues across turns and only ends on SessionEnd.
    const finalMessage = extractAssistantSummary(input);
    if (finalMessage.trim()) {
      await recordWithSession({ projectPath, externalSessionId, client: hookClient }, (sessionId) =>
        postJson("/events", { sessionId, type: "assistant_summary", content: finalMessage.slice(0, 2000) }));
    }
    await postJson("/process/auto", { projectPath, trigger: "turn_end" }).catch(() => undefined);
    await trackTokenUsage(input, projectPath, externalSessionId);
  } else if (eventName === "SessionEnd") {
    const finalMessage = extractAssistantSummary(input);
    if (finalMessage.trim()) {
      await recordWithSession({ projectPath, externalSessionId, client: hookClient }, (sessionId) =>
        postJson("/events", { sessionId, type: "assistant_summary", content: finalMessage.slice(0, 2000) })).catch(() => undefined);
    }
    const session = await readSession(externalSessionId);
    try {
      if (session?.sessionId) await postJson(`/sessions/${encodeURIComponent(session.sessionId)}/end`, {});
    } finally {
      // Always clear the local cache, even if the end-call failed — otherwise a
      // stale session id gets replayed forever and recording silently dies.
      await removeSession(externalSessionId);
    }
    await trackTokenUsage(input, projectPath, externalSessionId);
  }
} catch (error) {
  await appendLocalError({
    createdAt: new Date().toISOString(),
    eventName,
    projectPath,
    externalSessionId,
    error: error instanceof Error ? error.message : String(error)
  });
}

async function ensurePeonSession({ projectPath, externalSessionId, client }) {
  const existing = await readSession(externalSessionId);
  if (existing?.projectPath === projectPath && existing.sessionId) return existing.sessionId;
  const started = await postJson("/sessions", { projectPath, client, cwd: projectPath });
  await writeSession(externalSessionId, {
    sessionId: started.sessionId,
    projectPath,
    client,
    startedAt: new Date().toISOString()
  });
  return started.sessionId;
}

/**
 * Record through the project's Peon session, self-healing if the daemon has
 * forgotten it (restart, or the session was ended). On "Unknown Peon session"
 * we drop the stale cache, recreate the session, and retry once — so a daemon
 * bounce can never silently break recording for the rest of the Claude session.
 */
async function recordWithSession(ctx, run) {
  const sessionId = await ensurePeonSession(ctx);
  try {
    return await run(sessionId);
  } catch (error) {
    if (!/Unknown Peon session/i.test(String(error && error.message))) throw error;
    await removeSession(ctx.externalSessionId);
    const fresh = await ensurePeonSession(ctx);
    return await run(fresh);
  }
}

async function trackTokenUsage(input, projectPath, externalSessionId) {
  const transcriptPath = readText(input, ["transcript_path", "transcriptPath"]);
  if (transcriptPath) await recordTokenUsage({ projectPath, externalSessionId, transcriptPath });
}

function formatToolUse(input) {
  const toolName = extractText(readFirst(input, ["tool_name", "toolName", "tool.name", "tool", "name"])) || "unknown";
  const toolInput = summarize(readFirst(input, ["tool_input", "toolInput", "input", "arguments", "args"]) || {});
  const toolResponse = summarize(readFirst(input, ["tool_response", "toolResponse", "response", "result", "output"]) || {});
  return [`Tool used: ${toolName}`, `Input: ${toolInput}`, `Output: ${toolResponse}`].join("\n");
}

function summarize(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1200 ? `${text.slice(0, 1200)}...` : text;
}

async function postJson(path, body) {
  const response = await fetch(`${daemonUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getProjectContext(projectPath, query) {
  const url = new URL(`${daemonUrl}/context`);
  url.searchParams.set("projectPath", projectPath);
  url.searchParams.set("query", String(query ?? "").slice(0, MAX_CONTEXT_QUERY_CHARS));
  url.searchParams.set("maxChars", "6000");
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`/context failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Build the memory packet handed to a subagent at spawn. Subagents work on tasks
 * that may live in OTHER project brains (e.g. a worker extracting from the DTS-SQL
 * paper while the main session is in Master Project 700B), so this pulls the
 * current project's context AND a cross-project recall for the worker's task —
 * so workers don't redo work already captured anywhere in Peon.
 */
async function buildSubagentContext(task, projectPath) {
  const query = (task || "recent project context decisions artifacts current work").slice(0, 600);
  let local = "";
  try {
    local = formatRelevantMemory(await getProjectContext(projectPath, query)); // already carries the directive
  } catch { /* best effort */ }
  let cross = "";
  try {
    cross = await getCrossProjectRecall(query, projectPath);
  } catch { /* best effort */ }
  if (!local && !cross) return "";
  if (local) return cross ? `${local}\n\n${cross}` : local;
  return `${PEON_FIRST_DIRECTIVE}\n${cross}`; // cross-only path needs the directive
}

async function getCrossProjectRecall(query, excludeProjectPath) {
  const url = new URL(`${daemonUrl}/cross-context`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "10");
  if (excludeProjectPath) url.searchParams.set("exclude", excludeProjectPath);
  const response = await fetch(url);
  if (!response.ok) return "";
  const data = JSON.parse((await response.text()) || "{}");
  const hits = (data.results || []).filter((h) => h && h.record && h.record.content);
  if (hits.length === 0) return "";
  const lines = hits
    .slice(0, 10)
    .map((h) => `- [${h.projectName}] ${String(h.record.content).slice(0, 200)}`)
    .join("\n");
  return `From your OTHER projects (work already done elsewhere — reuse it, don't redo it):\n${lines}`;
}

function formatRelevantMemory(context) {
  const sections = [
    ["Peon Global Brain (applies to every project)", context.global],
    ["Summary", context.summary],
    ["Memory Records", context.memories],
    ["Decisions", context.decisions],
    ["Preferences", context.preferences],
    ["Open Questions", context.openQuestions],
    ["Artifacts", context.artifacts],
    ["Recent Timeline", context.timeline]
  ]
    .map(([title, value]) => formatSection(title, value))
    .filter(Boolean);

  if (sections.length === 0) return "";
  const body = sections.join("\n\n");
  if (!hasUsefulMemory(body)) return "";
  // Lead with the single most query-relevant belief as a banner, so the decisive fact is the
  // FIRST thing the agent reads — not buried mid-block where it gets skipped and re-derived.
  const banner = context.headline
    ? `\n⚠ MOST RELEVANT — this is already in memory; use it and do NOT re-run/re-derive to rediscover it:\n  ${context.headline}\n`
    : "";
  return `${PEON_FIRST_DIRECTIVE}${banner}\nPeon Relevant Memory\n${body.slice(0, 4500)}\n`;
}

function formatStartupContext(context) {
  const sections = [
    ["Peon Global Brain (applies to every project)", context.global],
    ["Summary", context.summary],
    ["Memory Records", context.memories],
    ["Decisions", context.decisions],
    ["Preferences", context.preferences],
    ["Open Questions", context.openQuestions],
    ["Artifacts", context.artifacts],
    ["Recent Timeline", context.timeline]
  ]
    .map(([title, value]) => formatSection(title, value))
    .filter(Boolean);

  if (sections.length === 0) return "";
  const body = sections.join("\n\n");
  if (!hasUsefulMemory(body)) return "";
  return `${PEON_FIRST_DIRECTIVE}\nPeon Context\n${body.slice(0, 6000)}\n`;
}

function formatSection(title, value) {
  const text = String(value || "").trim();
  if (!text || text === `# ${title}`) return "";
  if (text.includes("No recorded memory yet.")) return "";
  const cleaned = text
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("# "))
    .slice(0, 24)
    .join("\n")
    .trim();
  return cleaned ? `## ${title}\n${cleaned}` : "";
}

function hasUsefulMemory(text) {
  return /AI Summary|Recent Memory|^- |XO|decision|preference|artifact|commit|implemented|built/im.test(text);
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid_json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readSession(externalSessionId) {
  const path = sessionPath(externalSessionId);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeSession(externalSessionId, session) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(sessionPath(externalSessionId), JSON.stringify(session, null, 2), "utf8");
}

async function removeSession(externalSessionId) {
  await rm(sessionPath(externalSessionId), { force: true }).catch(() => undefined);
}

function sessionPath(externalSessionId) {
  return join(stateDir, `${safeName(externalSessionId)}.json`);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function recordTokenUsage({ projectPath, externalSessionId, transcriptPath }) {
  try {
    // Only log once per session — Stop fires on every response turn, not just session end.
    const logged = JSON.parse(await readFile(TOKEN_AB_LOGGED_SESSIONS, "utf8").catch(() => "[]"));
    if (logged.includes(externalSessionId)) return;

    const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, model: "unknown" };
    const rl = createInterface({ input: fsCreateReadStream(transcriptPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const usage = obj?.message?.usage;
        if (!usage) continue;
        totals.input += usage.input_tokens || 0;
        totals.output += usage.output_tokens || 0;
        totals.cacheRead += usage.cache_read_input_tokens || 0;
        totals.cacheCreate += usage.cache_creation_input_tokens || 0;
        if (obj?.message?.model) totals.model = obj.message.model;
      } catch { /* skip malformed lines */ }
    }
    const peonEnabled = !/^(1|true|yes|on)$/i.test(process.env.PEON_DISABLED || "");
    const record = {
      ts: new Date().toISOString(),
      projectPath,
      sessionId: externalSessionId,
      peonEnabled,
      model: totals.model,
      inputTokens: totals.input,
      outputTokens: totals.output,
      cacheReadTokens: totals.cacheRead,
      cacheCreateTokens: totals.cacheCreate,
      totalTokens: totals.input + totals.output,
    };
    const dir = join(homedir(), "Library", "Application Support", "Peon");
    await mkdir(dir, { recursive: true });
    await appendFile(TOKEN_AB_LOG, JSON.stringify(record) + "\n", "utf8");
    // Mark session as logged (keep last 500 to avoid unbounded growth)
    logged.push(externalSessionId);
    await writeFile(TOKEN_AB_LOGGED_SESSIONS, JSON.stringify(logged.slice(-500)), "utf8");
  } catch (e) { if (process.env.PEON_AB_DEBUG) console.error("AB-ERR:", e && e.message); }
}

async function appendLocalError(error) {
  await mkdir(stateDir, { recursive: true });
  await appendFile(join(stateDir, "errors.jsonl"), `${JSON.stringify(error)}\n`, "utf8");
}

function normalizeEventName(value) {
  const text = extractText(value).trim();
  const compact = text.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (compact === "subagentstart" || compact === "subagentstarted") return "SubagentStart";
  if (compact === "subagentstop" || compact === "subagentend" || compact === "subagentfinished") return "SubagentStop";
  if (compact === "sessionstart" || compact === "start") return "SessionStart";
  if (compact === "userpromptsubmit" || compact === "promptsubmit" || compact === "userprompt") return "UserPromptSubmit";
  if (compact === "userpromptexpansion" || compact === "promptexpansion") return "UserPromptExpansion";
  if (compact === "pretooluse" || compact === "pretool") return "PreToolUse";
  if (compact === "posttooluse" || compact === "tooluse" || compact === "toolresult") return "PostToolUse";
  if (compact === "posttoolusefailure" || compact === "toolusefailure" || compact === "toolerror") return "PostToolUseFailure";
  if (compact === "stop" || compact === "sessionend" || compact === "end") return text === "SessionEnd" ? "SessionEnd" : "Stop";
  return text;
}

function extractAssistantSummary(input) {
  return extractText(
    readFirst(input, [
      "last_assistant_message",
      "lastAssistantMessage",
      "assistant_summary",
      "assistantSummary",
      "response.message.content",
      "response.message",
      "response",
      "message.content",
      "message",
      "output"
    ])
  );
}

function readText(input, paths) {
  return extractText(readFirst(input, paths)).trim();
}

function readFirst(input, paths) {
  for (const path of paths) {
    const value = readPath(input, path);
    if (value === undefined || value === null) continue;
    if (typeof value === "object") return value;
    if (extractText(value).trim()) return value;
  }
  return undefined;
}

function readPath(input, path) {
  return path.split(".").reduce((value, key) => {
    if (value && typeof value === "object" && key in value) return value[key];
    return undefined;
  }, input);
}

function extractText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return extractText(value.content);
    if (typeof value.message === "string" || Array.isArray(value.message) || typeof value.message === "object") {
      return extractText(value.message);
    }
  }
  return "";
}
