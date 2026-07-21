import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { URL } from "node:url";
import { PeonLogger } from "./logger.js";
import { renderMonitorHtml } from "./monitor.js";
import { renderTokenAbMonitorHtml } from "./token-ab-monitor.js";
import type { ConsolidationStats } from "./processor.js";
import { SessionIndex } from "./session-index.js";
import { createPeonTools } from "./tools.js";
import {
  summarizeBeliefs,
  detectDuplicates,
  computeTokenSavings,
  enrichInjection,
  filterStrayProjects,
  type AbTokenRecord
} from "./overview.js";
import type {
  EndSessionToolInput,
  GetContextToolInput,
  RecordEventToolInput,
  RecordMessageToolInput,
  MaybeProcessMemoryToolInput,
  ProcessMemoryToolInput,
  GlobalMemoryToolInput,
  ImportGlobalMemoryToolInput,
  PromoteToGlobalToolInput,
  UpdateMemoryToolInput,
  DeleteMemoryToolInput,
  MergeMemoryToolInput,
  EvaluateProjectToolInput,
  StartSessionToolInput
} from "./tools.js";
import type { MemoryStatus, MemoryType, ProjectContext } from "./types.js";

export interface StartPeonDaemonOptions {
  host?: string;
  port?: number;
  logDir?: string;
  globalMemoryDir?: string;
}

export interface PeonDaemonHandle {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ActiveSession {
  id: string;
  projectPath: string;
  client: string;
  startedAt: string;
}

interface JsonResponse {
  status?: number;
  body: unknown;
}

interface MonitorState {
  knownProjects: Set<string>;
  recentTraffic: MonitorTrafficItem[];
  processingJobs: MonitorProcessingJob[];
  tokens: TokenStats;
  /** The most recent retrieval query per project — powers the Overview "last injection" widget. */
  lastQueryByProject: Map<string, string>;
  /** Belief ids served since the last brain pass, per project — fed to reinforcement. */
  recalledByProject: Map<string, string[]>;
  /** Vitals: when the brain last pulsed, and when it last did real work per project. */
  lastHeartbeatAt?: string;
  lastDreamByProject: Map<string, string>;
  /** When each project was last LLM-recurated — throttles the costly trim to ~once/day. */
  lastRecuratedByProject: Map<string, string>;
}

interface TokenRun {
  createdAt: string;
  projectPath: string;
  model: string;
  tokens: number;
  superseded?: number;
  merged?: number;
  recordsAdded?: number;
}

interface TokenStats {
  total: number;
  runs: number;
  byModel: Record<string, { tokens: number; runs: number }>;
  byProject: Record<string, number>;
  recent: TokenRun[];
}

function emptyTokenStats(): TokenStats {
  return { total: 0, runs: 0, byModel: {}, byProject: {}, recent: [] };
}

/** Record one consolidation's token cost into the running totals. */
function addTokenRun(stats: TokenStats, run: TokenRun): void {
  const tokens = Number.isFinite(run.tokens) ? Math.max(0, Math.trunc(run.tokens)) : 0;
  stats.total += tokens;
  stats.runs += 1;
  const model = run.model || "unknown";
  stats.byModel[model] ??= { tokens: 0, runs: 0 };
  stats.byModel[model].tokens += tokens;
  stats.byModel[model].runs += 1;
  stats.byProject[run.projectPath] = (stats.byProject[run.projectPath] ?? 0) + tokens;
  stats.recent.unshift({ ...run, tokens });
  if (stats.recent.length > 50) stats.recent.length = 50;
}

/** Seed token totals from the on-disk log on boot, so history survives restarts. */
async function seedTokenStats(logger: PeonLogger): Promise<TokenStats> {
  const stats = emptyTokenStats();
  const entries = await logger.recent(50000).catch(() => []);
  // recent() returns newest-first; reverse so recent[] ends up newest-first after unshift.
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "process_finish" && entry.type !== "auto_process_finish") continue;
    if (entry.status && entry.status !== "processed") continue;
    addTokenRun(stats, {
      createdAt: String(entry.createdAt ?? ""),
      projectPath: String(entry.projectPath ?? "unknown"),
      model: String(entry.model ?? "unknown"),
      tokens: Number(entry.estimatedTokens) || 0,
      superseded: typeof entry.superseded === "number" ? entry.superseded : undefined,
      merged: typeof entry.merged === "number" ? entry.merged : undefined,
      recordsAdded: typeof entry.recordsAdded === "number" ? entry.recordsAdded : undefined
    });
  }
  return stats;
}

interface MonitorTrafficItem {
  id: string;
  projectPath?: string;
  sessionId?: string;
  type: string;
  content: string;
  createdAt: string;
}

interface MonitorProcessingJob {
  id: string;
  projectPath: string;
  reason: string;
  status: "processed" | "skipped" | "failed";
  model?: string;
  estimatedTokens?: number;
  error?: string;
  createdAt: string;
  stats?: ConsolidationStats;
}

function contextChars(context: ProjectContext): number {
  return [
    context.summary,
    context.memories,
    context.decisions,
    context.preferences,
    context.openQuestions,
    context.artifacts,
    context.timeline
  ].reduce((sum, section) => sum + (section ? section.length : 0), 0);
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3737;
const DEFAULT_STATE_DIR = join(homedir(), "Library", "Application Support", "Peon");
// Sessions still "active" after this long are assumed orphaned by a crashed run.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// High-frequency UI/health endpoints whose request/response logging is pure noise.
const NOISY_LOG_PATHS = new Set(["/monitor", "/monitor/state", "/token-ab-monitor", "/health", "/logs", "/favicon.ico"]);
// Temp roots — no real user project lives here. Throwaway test/hook projects do.
const TEMP_ROOTS = [tmpdir(), "/tmp", "/var/folders", "/private/var/folders", "/private/tmp"];
// Escape hatch (tests): treat every known project as real, including temp dirs.
const SHOW_ALL_PROJECTS = /^(1|true|yes|on)$/i.test(process.env.PEON_SHOW_ALL_PROJECTS ?? "");

/**
 * Resolve any path to its ONE project brain: collapse git-worktree paths to the repo root, then
 * climb ancestors (bounded by home). A `.peon/root` marker declares a brain BOUNDARY — the nearest
 * one wins and the climb stops there, so a big sub-project (e.g. a thesis folder) keeps its OWN
 * brain instead of being swallowed by the parent. With no marker anywhere the behaviour is
 * unchanged: climb to the TOPMOST `.peon` (unify stray subfolders onto the root brain). Applied at
 * the daemon boundary so EVERY caller (Claude hook, direct MCP, Codex) resolves a path identically
 * — not just the hook. Mirrors resolveProjectPath() in scripts/claude-peon-hook.mjs.
 */
export function canonicalProjectPath(projectPath: string, home: string = homedir()): string {
  const marker = "/.claude/worktrees/";
  const idx = projectPath.indexOf(marker);
  const base = idx !== -1 ? projectPath.slice(0, idx) : projectPath;
  let dir = base;
  let rootBrain: string | null = null;
  while (dir && dir.startsWith(home) && dir !== home) {
    if (existsSync(join(dir, ".peon"))) {
      if (existsSync(join(dir, ".peon", "root"))) return dir; // boundary marker — this is its own brain
      rootBrain = dir; // otherwise topmost-wins (unify subfolders onto the root brain)
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return rootBrain ?? base;
}

/**
 * Reject requests that aren't from a loopback caller — defeats DNS-rebinding and drive-by-localhost
 * attacks where a malicious web page POSTs to the daemon (which would otherwise write/read a brain
 * at an attacker-controlled path). A bad Host header (rebinding) or a cross-origin Origin/Referer
 * (browser drive-by) is refused. The node hook (no Origin) and the local monitor UI (loopback
 * Origin) both pass.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}
/** Extract the hostname from a Host header, handling [ipv6]:port and host:port without the
 *  ":-split" bug that let a malformed "::evil" Host parse to an empty (loopback-looking) string. */
function hostnameFromHostHeader(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  const colons = (value.match(/:/g) ?? []).length;
  if (colons === 1) return value.slice(0, value.indexOf(":")); // host:port
  return value; // bare host (0 colons) or bracketless ipv6 (ambiguous) → fails the loopback check
}
function isLocalRequest(request: IncomingMessage): boolean {
  const rawHost = request.headers.host;
  // A present Host must be loopback (a missing Host — rare, HTTP/1.0 — is allowed; bind is 127.0.0.1).
  if (rawHost !== undefined && !isLoopbackHostname(hostnameFromHostHeader(String(rawHost)))) return false;
  for (const header of [request.headers.origin, request.headers.referer]) {
    if (!header) continue;
    try {
      if (!isLoopbackHostname(new URL(String(header)).hostname)) return false;
    } catch {
      return false; // unparseable Origin/Referer → refuse
    }
  }
  return true;
}

function isTempProjectPath(projectPath: string): boolean {
  if (SHOW_ALL_PROJECTS) return false;
  return TEMP_ROOTS.some((root) => projectPath === root || projectPath.startsWith(root + "/"));
}

/** A project worth tracking: its brain exists on disk and it is NOT a temp/test dir. */
function isRealProjectPath(projectPath: string): boolean {
  return existsSync(join(projectPath, ".peon")) && !isTempProjectPath(projectPath);
}

export async function startPeonDaemon(options: StartPeonDaemonOptions = {}): Promise<PeonDaemonHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const stateDir = options.logDir ?? DEFAULT_STATE_DIR;
  const sessionIndexPath = join(stateDir, "sessions-index.json");
  const tools = createPeonTools({ globalMemoryDir: options.globalMemoryDir, sessionIndexPath });
  const logger = new PeonLogger({ logDir: options.logDir });
  const projectRegistry = new ProjectRegistry(stateDir);
  const sessionIndex = new SessionIndex(sessionIndexPath);
  const activeSessions = new Map<string, ActiveSession>();
  // Clear zombie sessions left behind by a crashed run before rehydrating, so the
  // monitor never shows sessions that no client will ever end.
  await sessionIndex.prune(Date.now(), SESSION_MAX_AGE_MS).catch(() => 0);
  // Rehydrate in-flight sessions so a daemon restart doesn't lose the monitor view
  // or orphan sessions that clients are still recording into.
  for (const record of await sessionIndex.active()) {
    activeSessions.set(record.sessionId, {
      id: record.sessionId,
      projectPath: record.projectPath,
      client: record.client,
      startedAt: record.startedAt
    });
  }
  const monitorState: MonitorState = {
    knownProjects: await projectRegistry.read(),
    recentTraffic: [],
    processingJobs: [],
    tokens: await seedTokenStats(logger),
    lastQueryByProject: new Map(),
    recalledByProject: new Map(),
    lastDreamByProject: new Map(),
    lastRecuratedByProject: new Map()
  };
  // Permanently forget throwaway temp/test projects and brains deleted off disk,
  // and collapse any stale worktree paths to their repo root. Keeps the UI clean.
  const liveProjects = new Set(
    [...monitorState.knownProjects].map((p) => canonicalProjectPath(p)).filter(isRealProjectPath)
  );
  if (liveProjects.size !== monitorState.knownProjects.size) {
    monitorState.knownProjects = liveProjects;
    await projectRegistry.write(liveProjects).catch(() => undefined);
  }

  const server = createServer(async (request, response) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const requestMethod = request.method ?? "GET";
    // The monitor polls /monitor/state every 2s; logging that floods the analysis
    // log with thousands of meaningless entries. Skip the high-frequency UI/health
    // endpoints — errors are still logged below regardless.
    // Security: only serve loopback callers (blocks DNS-rebinding / drive-by-localhost).
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { error: "forbidden: non-local request origin" });
      return;
    }
    const noisy = NOISY_LOG_PATHS.has(requestUrl.pathname);
    if (!noisy) {
      await logger.log("request_in", {
        requestId,
        method: requestMethod,
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams.entries())
      });
    }
    try {
      const result = await routeRequest(request, tools, activeSessions, monitorState, logger, projectRegistry);
      if ("html" in result) {
        sendHtml(response, result.status ?? 200, result.html);
      } else {
        sendJson(response, result.status ?? 200, result.body);
      }
      if (!noisy) {
        await logger.log("response_out", {
          requestId,
          method: requestMethod,
          path: requestUrl.pathname,
          status: result.status ?? 200,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      // Only send an error response if the success path hasn't already responded
      // (e.g. a post-response logging failure must not trigger a double-send).
      if (!response.headersSent) {
        sendJson(response, statusForError(error), {
          error: error instanceof Error ? error.message : "Unknown Peon daemon error"
        });
      }
      await logger.log("response_out", {
        requestId,
        method: requestMethod,
        path: requestUrl.pathname,
        status: statusForError(error),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown Peon daemon error"
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // ─── The heartbeat: the brain stays ALIVE even with no active session ───
  // Every pulse, sweep each real project and run a cost-free autonomous pass
  // (reinforce / resolve conflicts / merge duplicates). LLM compression is left
  // to the cost-gated consolidation path. Off-switch: PEON_BRAIN_ASLEEP.
  const heartbeatMs = Number.parseInt(process.env.PEON_HEARTBEAT_MS ?? "", 10);
  const pulseMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 30000 ? heartbeatMs : 180000;
  const asleep = /^(1|true|yes|on)$/i.test(process.env.PEON_BRAIN_ASLEEP ?? "");
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (!asleep) {
    heartbeat = setInterval(() => {
      void pulseBrain(tools, monitorState, logger);
    }, pulseMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }

  const address = server.address() as AddressInfo;
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => {
      if (heartbeat) clearInterval(heartbeat);
      return closeServer(server);
    }
  };
}

/** One heartbeat pulse: run an autonomous brain pass over every real project. */
async function pulseBrain(
  tools: ReturnType<typeof createPeonTools>,
  monitorState: MonitorState,
  logger: PeonLogger
): Promise<void> {
  monitorState.lastHeartbeatAt = new Date().toISOString();
  for (const projectPath of monitorState.knownProjects) {
    if (!isRealProjectPath(projectPath)) continue;
    try {
      const recalledIds = monitorState.recalledByProject.get(projectPath);
      const { actions } = await tools.brainPass({ projectPath, recalledIds });
      monitorState.recalledByProject.delete(projectPath);
      if (actions.length > 0) {
        monitorState.lastDreamByProject.set(projectPath, new Date().toISOString());
        await logger.log("brain_pulse", { projectPath, actions: actions.length, kinds: actions.map((a) => a.type) });
      }
    } catch (error) {
      await logger.log("brain_pulse_fail", { projectPath, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  // The global brain curates itself too (cost-free deterministic pass on the pulse).
  try {
    const { actions } = await tools.globalBrainPass({});
    if (actions.length > 0) await logger.log("global_brain_pulse", { actions: actions.length, kinds: actions.map((a) => a.type) });
  } catch (error) {
    await logger.log("global_brain_pulse_fail", { error: error instanceof Error ? error.message : "unknown" });
  }

  // Costly LLM re-curation (trims ephemeral trivia) runs at most once per project
  // per interval, ONE project per pulse — so the cost is spread thin and bounded.
  // It's conservative + capped + recoverable (archives, never deletes).
  await maybeRecurate(tools, monitorState, logger);
}

const RECURATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Pick the single most-overdue project and re-curate it (throttled, best-effort). */
async function maybeRecurate(
  tools: ReturnType<typeof createPeonTools>,
  monitorState: MonitorState,
  logger: PeonLogger
): Promise<void> {
  if (/^(1|true|yes|on)$/i.test(process.env.PEON_RECURATE_OFF ?? "")) return;
  const now = Date.now();
  const due = [...monitorState.knownProjects]
    .filter(isRealProjectPath)
    .filter((p) => {
      const last = monitorState.lastRecuratedByProject.get(p);
      return !last || now - Date.parse(last) > RECURATE_INTERVAL_MS;
    })
    // Oldest (or never) first.
    .sort((a, b) => Date.parse(monitorState.lastRecuratedByProject.get(a) ?? "0") - Date.parse(monitorState.lastRecuratedByProject.get(b) ?? "0"));
  const projectPath = due[0];
  if (!projectPath) return;
  // Stamp BEFORE running so a slow/failed pass doesn't get retried every pulse.
  monitorState.lastRecuratedByProject.set(projectPath, new Date().toISOString());
  try {
    const result = await tools.recurateProject({ projectPath });
    if (result.archived > 0 || result.capped) {
      await logger.log("recurate", { projectPath, archived: result.archived, considered: result.considered, capped: result.capped ?? false });
    }
  } catch (error) {
    await logger.log("recurate_fail", { projectPath, error: error instanceof Error ? error.message : "unknown" });
  }
}

async function routeRequest(
  request: IncomingMessage,
  tools: ReturnType<typeof createPeonTools>,
  activeSessions: Map<string, ActiveSession>,
  monitorState: MonitorState,
  logger: PeonLogger,
  projectRegistry: ProjectRegistry
): Promise<JsonResponse | { status?: number; html: string }> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    return { body: { ok: true, service: "peon-daemon" } };
  }

  if ((method === "GET" || method === "HEAD") && url.pathname === "/monitor") {
    return { html: renderMonitorHtml() };
  }

  if ((method === "GET" || method === "HEAD") && url.pathname === "/token-ab-monitor") {
    return { html: renderTokenAbMonitorHtml() };
  }

  if (method === "GET" && url.pathname === "/monitor/state") {
    return { body: await buildMonitorState(tools, activeSessions, monitorState, logger) };
  }

  if (method === "GET" && url.pathname === "/logs") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    return { body: { entries: await logger.recent(Number.isFinite(limit) ? limit : 100) } };
  }

  if (method === "GET" && url.pathname === "/sessions") {
    return { body: { active: Array.from(activeSessions.values()) } };
  }

  if (method === "POST" && url.pathname === "/sessions") {
    const input = await readJson<StartSessionToolInput>(request);
    // Resolve the project the SAME way the hook does, so a raw cwd from a direct-MCP client (e.g.
    // Codex) binds the session to the same brain Claude Code's hook would — not a divergent fork.
    if (input.projectPath) input.projectPath = canonicalProjectPath(input.projectPath);
    if (input.cwd) input.cwd = canonicalProjectPath(input.cwd);
    const result = await tools.startSession(input);
    await rememberProject(monitorState, projectRegistry, result.projectPath);
    activeSessions.set(result.sessionId, {
      id: result.sessionId,
      projectPath: result.projectPath,
      client: input.client,
      startedAt: new Date().toISOString()
    });
    rememberTraffic(monitorState, {
      id: crypto.randomUUID(),
      projectPath: result.projectPath,
      sessionId: result.sessionId,
      type: "session_started",
      content: `Session started for ${input.client}`,
      createdAt: new Date().toISOString()
    });
    return { status: 201, body: result };
  }

  if (method === "POST" && url.pathname === "/messages") {
    const input = await readJson<RecordMessageToolInput>(request);
    const result = await tools.recordMessage(input);
    rememberTraffic(monitorState, {
      id: result.id,
      projectPath: activeSessions.get(input.sessionId)?.projectPath,
      sessionId: input.sessionId,
      type: "message",
      content: input.content,
      createdAt: result.createdAt
    });
    return { status: 201, body: result };
  }

  if (method === "POST" && url.pathname === "/events") {
    const input = await readJson<RecordEventToolInput>(request);
    const result = await tools.recordEvent(input);
    rememberTraffic(monitorState, {
      id: result.id,
      projectPath: activeSessions.get(input.sessionId)?.projectPath,
      sessionId: input.sessionId,
      type: input.type,
      content: input.content,
      createdAt: result.createdAt
    });
    return { status: 201, body: result };
  }

  if (method === "POST" && url.pathname === "/process") {
    const input = await readJson<ProcessMemoryToolInput>(request);
    await rememberProject(monitorState, projectRegistry, input.projectPath);
    const job: MonitorProcessingJob = {
      id: crypto.randomUUID(),
      projectPath: input.projectPath,
      reason: input.reason ?? "manual",
      status: "processed",
      createdAt: new Date().toISOString()
    };
    try {
      await logger.log("process_start", {
        projectPath: input.projectPath,
        reason: input.reason ?? "manual"
      });
      const result = await tools.processMemory(input);
      job.model = result.model;
      job.estimatedTokens = result.estimatedTokens;
      monitorState.processingJobs.unshift(job);
      trim(monitorState.processingJobs, 30);
      job.stats = result.stats;
      addTokenRun(monitorState.tokens, {
        createdAt: job.createdAt,
        projectPath: input.projectPath,
        model: result.model,
        tokens: result.estimatedTokens,
        superseded: result.stats?.superseded,
        merged: result.stats?.merged,
        recordsAdded: result.stats?.recordsAdded
      });
      await logger.log("process_finish", {
        projectPath: input.projectPath,
        reason: input.reason ?? "manual",
        status: result.status,
        model: result.model,
        estimatedTokens: result.estimatedTokens,
        operationsEmitted: result.stats?.operationsEmitted,
        superseded: result.stats?.superseded,
        obsoleted: result.stats?.obsoleted,
        recordsAdded: result.stats?.recordsAdded,
        merged: result.stats?.merged
      });
      // Auto-promote cross-cutting beliefs to global memory so any project can
      // recall them — best-effort, never fails the consolidation.
      await autoPromoteToGlobal(tools, logger, input.projectPath);
      return { status: 201, body: result };
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Unknown processing error";
      monitorState.processingJobs.unshift(job);
      trim(monitorState.processingJobs, 30);
      await logger.log("process_fail", {
        projectPath: input.projectPath,
        reason: input.reason ?? "manual",
        error: job.error
      });
      throw error;
    }
  }

  if (method === "POST" && url.pathname === "/process/auto") {
    const input = await readJson<MaybeProcessMemoryToolInput>(request);
    await rememberProject(monitorState, projectRegistry, input.projectPath);
    return { status: 201, body: await runAutomaticProcessing(tools, monitorState, logger, input) };
  }

  const endSessionMatch = url.pathname.match(/^\/sessions\/([^/]+)\/end$/);
  if (method === "POST" && endSessionMatch) {
    const input: EndSessionToolInput = { sessionId: decodeURIComponent(endSessionMatch[1]) };
    let result: Awaited<ReturnType<typeof tools.endSession>>;
    try {
      result = await tools.endSession(input);
    } catch (error) {
      // A SessionEnd hook must NEVER receive a 500 — that errors the user's Claude session.
      // An unknown session (started before a daemon restart that didn't index it, or already
      // ended) simply has nothing to consolidate; degrade to a benign no-op.
      if (error instanceof Error && /Unknown Peon session/.test(error.message)) {
        activeSessions.delete(input.sessionId);
        return { body: { sessionId: input.sessionId, status: "unknown_session" } };
      }
      throw error;
    }
    activeSessions.delete(input.sessionId);
    await rememberProject(monitorState, projectRegistry, result.projectPath);
    rememberTraffic(monitorState, {
      id: crypto.randomUUID(),
      projectPath: result.projectPath,
      sessionId: input.sessionId,
      type: "session_ended",
      content: "Session ended",
      createdAt: result.endedAt ?? new Date().toISOString()
    });
    const autoProcessing = await runAutomaticProcessing(tools, monitorState, logger, {
      projectPath: result.projectPath,
      trigger: "session_end"
    });
    return { body: { ...result, autoProcessing } };
  }

  if (method === "GET" && url.pathname === "/context") {
    const rawProjectPath = url.searchParams.get("projectPath");
    if (!rawProjectPath) throw new BadRequestError("projectPath is required");
    // Canonicalize so a direct-MCP caller (Codex) reads the SAME brain the hook would inject —
    // a raw cwd was hitting a divergent per-subfolder fork and missing the real history.
    const projectPath = canonicalProjectPath(rawProjectPath);
    const input: GetContextToolInput = {
      projectPath,
      query: url.searchParams.get("query") ?? undefined,
      maxChars: optionalNumber(url.searchParams.get("maxChars"))
    };
    const servedAt = Date.now();
    const context = await tools.getContext(input);
    const latencyMs = Date.now() - servedAt;
    // Remember the live prompt so the Overview can replay "what Peon injected last".
    if (input.query && input.query.trim()) monitorState.lastQueryByProject.set(projectPath, input.query.trim());
    // Accumulate which beliefs were recalled so the next brain pass reinforces them.
    if (context.recalledIds && context.recalledIds.length > 0) {
      const prior = monitorState.recalledByProject.get(projectPath) ?? [];
      monitorState.recalledByProject.set(projectPath, Array.from(new Set([...prior, ...context.recalledIds])).slice(-100));
    }
    // Log what the brain actually GAVE BACK for this prompt — the key signal for analysing how
    // well retrieval served each request. Includes serve-time telemetry (latency + an est. token
    // count) so the LOW-COST/latency constraint can be OBSERVED in production, not just asserted
    // from offline harnesses — the STL monitor surfaces the averages.
    const chars = contextChars(context);
    await logger.log("context_served", {
      projectPath,
      query: input.query,
      chars,
      estTokens: Math.round(chars / 4), // ~4 chars/token heuristic — good enough for trend/telemetry
      latencyMs,
      compacted: context.meta?.compacted ?? false,
      maxChars: context.meta?.maxChars
    });
    return { body: context };
  }

  if (method === "GET" && url.pathname === "/brain") {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    return {
      body: await tools.inspectBrain({
        projectPath,
        query: url.searchParams.get("query") ?? undefined,
        maxChars: optionalNumber(url.searchParams.get("maxChars"))
      })
    };
  }

  if (method === "GET" && url.pathname === "/search") {
    const projectPath = url.searchParams.get("projectPath");
    const query = url.searchParams.get("query");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    if (!query) throw new BadRequestError("query is required");
    return {
      body: await tools.searchMemory({
        projectPath: canonicalProjectPath(projectPath),
        query,
        limit: optionalNumber(url.searchParams.get("limit")),
        maxChars: optionalNumber(url.searchParams.get("maxChars"))
      })
    };
  }

  if (method === "GET" && url.pathname === "/quality") {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    return {
      body: await tools.qualityReport({
        projectPath,
        staleAfterDays: optionalNumber(url.searchParams.get("staleAfterDays"))
      })
    };
  }

  if (method === "GET" && url.pathname === "/cross-context") {
    const query = url.searchParams.get("query");
    if (!query) throw new BadRequestError("query is required");
    const target = url.searchParams.get("projectPath");
    const exclude = url.searchParams.get("exclude") ?? undefined;
    // One explicit target, or fan out across every project the daemon knows about.
    const projectPaths = target ? [target] : Array.from(monitorState.knownProjects);
    const result = await tools.crossProjectSearch({
      query,
      projectPaths,
      excludeProjectPath: exclude,
      limit: optionalNumber(url.searchParams.get("limit")),
      maxProjects: optionalNumber(url.searchParams.get("maxProjects"))
    });
    await logger.log("cross_context_served", {
      query,
      exclude,
      projectsSearched: result.projectsSearched.length,
      hits: result.results.length
    });
    return { body: result };
  }

  if (method === "GET" && url.pathname === "/injection") {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    return {
      body: await tools.buildInjection({
        projectPath,
        query: url.searchParams.get("query") ?? undefined,
        maxChars: optionalNumber(url.searchParams.get("maxChars")),
        includeInactive: url.searchParams.get("includeInactive") === "true"
      })
    };
  }

  if (method === "GET" && url.pathname === "/global/memories") {
    return {
      body: await tools.searchGlobalMemory({
        query: url.searchParams.get("query") ?? undefined,
        type: optionalMemoryType(url.searchParams.get("type")),
        status: optionalMemoryStatus(url.searchParams.get("status"))
      })
    };
  }

  if (method === "POST" && url.pathname === "/global/memories") {
    return { status: 201, body: await tools.rememberGlobal(await readJson<GlobalMemoryToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/global/import-project") {
    return { status: 201, body: await tools.importGlobalMemory(await readJson<ImportGlobalMemoryToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/global/promote") {
    return { status: 201, body: await tools.promoteToGlobal(await readJson<PromoteToGlobalToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/memory/update") {
    return { body: await tools.updateMemory(await readJson<UpdateMemoryToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/memory/delete") {
    return { body: await tools.deleteMemory(await readJson<DeleteMemoryToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/memory/merge") {
    return { body: await tools.mergeMemory(await readJson<MergeMemoryToolInput>(request)) };
  }

  if (method === "POST" && url.pathname === "/brain/pass") {
    const input = await readJson<{ projectPath: string; recalledIds?: string[]; compress?: boolean }>(request);
    return { body: await tools.brainPass(input) };
  }

  if (method === "POST" && url.pathname === "/global/brain-pass") {
    const input = await readJson<{ compress?: boolean }>(request);
    return { body: await tools.globalBrainPass(input) };
  }

  if (method === "POST" && url.pathname === "/global/extract") {
    const input = await readJson<{ projectPath: string }>(request);
    return { status: 201, body: await tools.extractGlobal(input) };
  }

  if (method === "POST" && url.pathname === "/recurate") {
    const input = await readJson<{ projectPath: string }>(request);
    return { body: await tools.recurateProject(input) };
  }

  if (method === "GET" && url.pathname === "/brain/activity") {
    const projectPaths = [...monitorState.knownProjects].filter(isRealProjectPath);
    return { body: await tools.brainActivity({ projectPaths, limit: optionalNumber(url.searchParams.get("limit")) }) };
  }

  if (method === "GET" && url.pathname === "/global/dashboard") {
    return { body: await tools.globalDashboard() };
  }

  if (method === "GET" && url.pathname === "/brain/actions") {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    return { body: await tools.brainActions({ projectPath, limit: optionalNumber(url.searchParams.get("limit")) }) };
  }

  if (method === "POST" && url.pathname === "/brain/restore") {
    const input = await readJson<{ projectPath: string }>(request);
    return { body: await tools.restoreBackup(input) };
  }

  if (method === "POST" && url.pathname === "/evaluate") {
    return { body: await tools.evaluateProject(await readJson<EvaluateProjectToolInput>(request)) };
  }

  if (method === "GET" && url.pathname === "/token-ab") {
    return { body: { records: await readTokenAbLog() } };
  }

  if (method === "GET" && url.pathname === "/overview") {
    const projectPath = url.searchParams.get("projectPath");
    if (!projectPath) throw new BadRequestError("projectPath is required");
    return { body: await buildOverviewPayload(tools, monitorState, projectPath) };
  }

  if (method === "GET" && url.pathname === "/network") {
    return { body: await buildNetworkPayload(tools, monitorState) };
  }

  return { status: 404, body: { error: `No Peon daemon route for ${method} ${url.pathname}` } };
}

async function readTokenAbLog(): Promise<AbTokenRecord[]> {
  const logPath = join(homedir(), "Library", "Application Support", "Peon", "token-ab-log.jsonl");
  const raw = await readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AbTokenRecord];
      } catch {
        return [];
      }
    });
}

/** Assemble the at-a-glance Overview for one project. */
async function buildOverviewPayload(
  tools: ReturnType<typeof createPeonTools>,
  monitorState: MonitorState,
  projectPath: string
): Promise<unknown> {
  const brain = await tools.inspectBrain({ projectPath });
  const globalRecords = await tools.searchGlobalMemory({ status: "active" }).catch(() => []);
  const counts = summarizeBeliefs(brain.records);
  const duplicates = detectDuplicates(brain.records);
  const conflicts = brain.records
    .filter((record) => record.status === "conflicted")
    .map((record) => ({ id: record.id, content: record.content }));
  const savings = computeTokenSavings(await readTokenAbLog(), projectPath);

  const query = monitorState.lastQueryByProject.get(projectPath) ?? "recent project context decisions current work";
  const injection = await tools.buildInjection({ projectPath, query, maxChars: 4000 }).catch(() => null);
  const lastInjection = injection
    ? { query, items: enrichInjection(injection.selected, [...brain.records, ...globalRecords]) }
    : { query, items: [] };

  const lastConsolidatedAt = brain.records
    .map((record) => record.updatedAt)
    .sort()
    .at(-1);

  const brainActions = await tools.brainActions({ projectPath, limit: 12 }).catch(() => []);

  return {
    projectPath,
    projectName: basename(projectPath),
    counts: { ...counts, project: counts.active, global: globalRecords.length },
    lastConsolidatedAt: lastConsolidatedAt ?? null,
    tokensSaved: savings,
    lastInjection,
    needsReview: { conflicts, duplicates },
    vitals: {
      alive: !/^(1|true|yes|on)$/i.test(process.env.PEON_BRAIN_ASLEEP ?? ""),
      lastHeartbeatAt: monitorState.lastHeartbeatAt ?? null,
      lastDreamAt: monitorState.lastDreamByProject.get(projectPath) ?? null
    },
    brainActions
  };
}

/** Assemble the cross-project + global-memory Network view. */
async function buildNetworkPayload(
  tools: ReturnType<typeof createPeonTools>,
  monitorState: MonitorState
): Promise<unknown> {
  const globalRecords = await tools.searchGlobalMemory({ status: "active" }).catch(() => []);
  const projects = await Promise.all(
    Array.from(monitorState.knownProjects)
      .filter((projectPath) => isRealProjectPath(projectPath))
      .map(async (projectPath) => {
        const brain = await tools.inspectBrain({ projectPath }).catch(() => null);
        const records = brain?.records ?? [];
        const counts = summarizeBeliefs(records);
        return {
          projectPath,
          projectName: basename(projectPath),
          active: counts.active,
          total: counts.total,
          pinned: counts.pinned
        };
      })
  );
  // Hide stray subdirectory brains (empty .peon from a subdir session) — never merges memory.
  const visible = filterStrayProjects(projects);
  return {
    global: globalRecords.map((record) => ({
      id: record.id,
      type: record.type,
      content: record.content,
      importance: record.score.importance,
      entities: record.entities
    })),
    projects: visible.sort((left, right) => right.active - left.active)
  };
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalMemoryType(value: string | null): MemoryType | undefined {
  if (
    value === "summary" ||
    value === "decision" ||
    value === "preference" ||
    value === "open_question" ||
    value === "artifact" ||
    value === "timeline" ||
    value === "fact"
  ) {
    return value;
  }
  return undefined;
}

function optionalMemoryStatus(value: string | null): MemoryStatus | undefined {
  if (value === "active" || value === "stale" || value === "conflicted" || value === "superseded" || value === "archived") return value;
  return undefined;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

/** Latest STL daily self-check verdict (headline + timestamp), or null if none written yet. */
async function readStlSummary(): Promise<{ headline: string; generatedAt: string } | null> {
  try {
    const raw = await readFile(join(homedir(), "Library", "Logs", "Peon", "stl", "latest.json"), "utf8");
    const parsed = JSON.parse(raw) as { headline?: string; generatedAt?: string };
    if (!parsed.headline) return null;
    return { headline: parsed.headline, generatedAt: parsed.generatedAt ?? "" };
  } catch {
    return null;
  }
}

async function buildMonitorState(
  tools: ReturnType<typeof createPeonTools>,
  activeSessions: Map<string, ActiveSession>,
  monitorState: MonitorState,
  logger: PeonLogger
): Promise<unknown> {
  // Only surface real projects (existing brain, not a temp/test dir).
  const live = Array.from(monitorState.knownProjects).filter(isRealProjectPath);
  const built = await Promise.all(
    live.map(async (projectPath) => {
      // inspectBrain already computes getContext internally — reuse it instead of calling
      // getContext a SECOND time per project (that ran ranking + spreading activation twice
      // on every 2s poll for every project).
      const brain = await readProjectBrain(tools, projectPath);
      const context = brain && !("error" in brain) ? brain.context : null;
      return { projectPath, context, brain };
    })
  );
  // Hide empty shells (a .peon dir with no remembered beliefs) — only show real brains.
  const projects = SHOW_ALL_PROJECTS
    ? built
    : built.filter((p) => p.brain && "records" in p.brain && Array.isArray(p.brain.records) && p.brain.records.length > 0);
  // Health strip: injection serve-cost over the last 24h (from the telemetry fields the
  // /context handler logs) + the daily STL self-check verdict — so the Ops page answers
  // "is Peon fast, and did its own daily check pass?" at a glance.
  const recentEntries = (await logger.recent(2000)) as Array<Record<string, unknown>>;
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const serves = recentEntries.filter(
    (e) => e.type === "context_served" && typeof e.latencyMs === "number" && new Date(String(e.createdAt)).getTime() > dayAgo
  );
  const lat = serves.map((e) => Number(e.latencyMs)).sort((a, b) => a - b);
  const health = {
    serve: lat.length
      ? {
          count: lat.length,
          avgMs: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
          p50Ms: lat[Math.floor(lat.length / 2)],
          p95Ms: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
          avgTokens: Math.round(serves.reduce((a, e) => a + (Number(e.estTokens) || 0), 0) / serves.length)
        }
      : null,
    stl: await readStlSummary()
  };
  return {
    service: "peon-daemon",
    generatedAt: new Date().toISOString(),
    activeSessions: Array.from(activeSessions.values()),
    recentTraffic: monitorState.recentTraffic,
    recentLogs: recentEntries.slice(-80),
    processingJobs: monitorState.processingJobs,
    tokens: monitorState.tokens,
    health,
    projects
  };
}

async function runAutomaticProcessing(
  tools: ReturnType<typeof createPeonTools>,
  monitorState: MonitorState,
  logger: PeonLogger,
  input: MaybeProcessMemoryToolInput
): Promise<Awaited<ReturnType<ReturnType<typeof createPeonTools>["maybeProcessMemory"]>> | { status: "failed"; error: string }> {
  const job: MonitorProcessingJob = {
    id: crypto.randomUUID(),
    projectPath: input.projectPath,
    reason: `auto:${input.trigger}`,
    status: "skipped",
    createdAt: new Date().toISOString()
  };
  try {
    await logger.log("auto_process_start", {
      projectPath: input.projectPath,
      trigger: input.trigger,
      force: input.force ?? false
    });
    const result = await tools.maybeProcessMemory(input);
    job.status = result.status;
    job.reason = `auto:${input.trigger}:${result.decision.reason}`;
    if (result.status === "processed") {
      job.model = result.result.model;
      job.estimatedTokens = result.result.estimatedTokens;
      job.stats = result.result.stats;
      addTokenRun(monitorState.tokens, {
        createdAt: job.createdAt,
        projectPath: input.projectPath,
        model: result.result.model,
        tokens: result.result.estimatedTokens,
        superseded: result.result.stats?.superseded,
        merged: result.result.stats?.merged,
        recordsAdded: result.result.stats?.recordsAdded
      });
    } else {
      job.estimatedTokens = result.decision.estimatedTokens;
    }
    monitorState.processingJobs.unshift(job);
    trim(monitorState.processingJobs, 30);
    await logger.log("auto_process_finish", {
      projectPath: input.projectPath,
      trigger: input.trigger,
      status: result.status,
      reason: result.decision.reason,
      rawChars: result.decision.rawChars,
      newChars: result.decision.newChars,
      estimatedTokens: job.estimatedTokens,
      model: job.model,
      operationsEmitted: job.stats?.operationsEmitted,
      superseded: job.stats?.superseded,
      obsoleted: job.stats?.obsoleted,
      recordsAdded: job.stats?.recordsAdded,
      merged: job.stats?.merged
    });
    // After a real consolidation (already past the cost gate), lift cross-cutting
    // beliefs into global AND run a full brain pass WITH LLM topic-compression.
    if (result.status === "processed") {
      await autoPromoteToGlobal(tools, logger, input.projectPath);
      // Let the model lift this project's cross-cutting knowledge into global memory.
      await tools
        .extractGlobal({ projectPath: input.projectPath })
        .then(({ promoted }) => promoted.length > 0 ? logger.log("global_extract", { projectPath: input.projectPath, promoted: promoted.length }) : undefined)
        .catch((error) => logger.log("global_extract_fail", { projectPath: input.projectPath, error: error instanceof Error ? error.message : "unknown" }));
      const recalledIds = monitorState.recalledByProject.get(input.projectPath);
      await tools
        .brainPass({ projectPath: input.projectPath, recalledIds, compress: true })
        .then(({ actions }) => {
          monitorState.recalledByProject.delete(input.projectPath);
          if (actions.length > 0) {
            monitorState.lastDreamByProject.set(input.projectPath, new Date().toISOString());
            return logger.log("brain_consolidate", { projectPath: input.projectPath, actions: actions.length, kinds: actions.map((a) => a.type) });
          }
          return undefined;
        })
        .catch((error) => logger.log("brain_consolidate_fail", { projectPath: input.projectPath, error: error instanceof Error ? error.message : "unknown" }));
    }
    return result;
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "Unknown automatic processing error";
    monitorState.processingJobs.unshift(job);
    trim(monitorState.processingJobs, 30);
    await logger.log("auto_process_fail", {
      projectPath: input.projectPath,
      trigger: input.trigger,
      error: job.error
    });
    // Do NOT re-throw: a failed consolidation (e.g. unparseable model output) must not bubble a
    // 500 out to the SessionEnd hook. It is already recorded as an auto_process_fail (so the STL
    // monitor still counts it) and the delta cursor was never advanced (processMemory threw before
    // writing processing-state), so the batch is retried on the next trigger.
    return { status: "failed", error: job.error };
  }
}

/**
 * Best-effort: copy this project's cross-cutting beliefs into global memory.
 * Never throws — a promotion failure must not break consolidation.
 */
async function autoPromoteToGlobal(
  tools: ReturnType<typeof createPeonTools>,
  logger: PeonLogger,
  projectPath: string
): Promise<void> {
  if (/^(1|true|yes|on)$/i.test(process.env.PEON_AUTO_PROMOTE_GLOBAL_OFF ?? "")) return;
  try {
    const { promoted } = await tools.promoteToGlobal({ projectPath });
    if (promoted.length > 0) {
      await logger.log("global_promote", {
        projectPath,
        promoted: promoted.length,
        types: promoted.map((record) => record.type)
      });
    }
  } catch (error) {
    await logger.log("global_promote_fail", {
      projectPath,
      error: error instanceof Error ? error.message : "Unknown promotion error"
    });
  }
}

async function readProjectBrain(
  tools: ReturnType<typeof createPeonTools>,
  projectPath: string
): Promise<Awaited<ReturnType<ReturnType<typeof createPeonTools>["inspectBrain"]>> | { error: string }> {
  try {
    return await tools.inspectBrain({ projectPath });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unable to inspect project brain" };
  }
}


function rememberTraffic(monitorState: MonitorState, item: MonitorTrafficItem): void {
  monitorState.recentTraffic.unshift(item);
  trim(monitorState.recentTraffic, 80);
}

async function rememberProject(
  monitorState: MonitorState,
  projectRegistry: ProjectRegistry,
  projectPath: string
): Promise<void> {
  // Never register throwaway temp/test projects — they only pollute the registry.
  if (isTempProjectPath(projectPath)) return;
  const canonical = canonicalProjectPath(projectPath);
  if (monitorState.knownProjects.has(canonical)) return;
  monitorState.knownProjects.add(canonical);
  await projectRegistry.write(monitorState.knownProjects);
}

function trim<T>(items: T[], max: number): void {
  if (items.length > max) items.splice(max);
}

class ProjectRegistry {
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "projects.json");
  }

  async read(): Promise<Set<string>> {
    const raw = await readFile(this.path, "utf8").catch(() => "");
    if (!raw.trim()) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
    } catch {
      return new Set();
    }
  }

  async write(projects: Set<string>): Promise<void> {
    await mkdir(this.path.slice(0, this.path.lastIndexOf("/")), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(Array.from(projects).sort(), null, 2)}\n`, "utf8");
  }
}

function statusForError(error: unknown): number {
  if (error instanceof BadRequestError) return 400;
  return 500;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class BadRequestError extends Error {}
