import { resolve } from "node:path";
import { PeonMemoryStore, defaultMaxDeltaChars } from "./memory-store.js";
import { resetModelSlots, withModelSlot } from "./model-slots.js";
import { llmEnabled, loadPeonConfig, type PeonConfig } from "./config.js";
import { createQualityReport } from "./quality.js";
import { extractDomainEntitiesViaModel } from "./entity-extraction.js";
import type { ConsolidationOperation, MemoryRecord, MemoryRecordInput, MemoryStatus, MemoryType, ProcessedMemory } from "./types.js";

export interface MemoryModelResult {
  content: string;
  model: string;
  estimatedTokens: number;
}

export interface MemoryModelClient {
  processMemory(input: { rawMemory: string; existingMemory?: string; config: PeonConfig; reason: string }): Promise<MemoryModelResult>;
}

export interface ProcessMemoryInput {
  projectPath: string;
  reason?: string;
  aiResult?: ProcessedMemory;
}

/** What a single consolidation run actually did — surfaced for observability. */
export interface ConsolidationStats {
  operationsEmitted: number;
  superseded: number;
  obsoleted: number;
  recordsAdded: number;
  merged: number;
}

export interface ProcessMemoryResult {
  status: "processed";
  model: string;
  estimatedTokens: number;
  applied: ProcessedMemory;
  stats: ConsolidationStats;
  /** True when the raw delta was capped this run (a backlog chunk) — more remains to drain. */
  capped: boolean;
}

export interface MaybeProcessMemoryInput {
  projectPath: string;
  trigger: string;
  force?: boolean;
  aiResult?: ProcessedMemory;
}

export interface ProcessingDecision {
  action: "process" | "skip";
  reason:
    | "forced"
    | "threshold_reached"
    | "below_threshold"
    | "ai_disabled"
    | "missing_api_key"
    | "empty_memory"
    | "in_progress";
  trigger: string;
  rawChars: number;
  newChars: number;
  flushMinChars: number;
  estimatedTokens: number;
}

export type MaybeProcessMemoryResult =
  | {
      status: "processed";
      decision: ProcessingDecision;
      result: ProcessMemoryResult;
    }
  | {
      status: "skipped";
      decision: ProcessingDecision;
    };

export interface PeonMemoryProcessorOptions {
  config?: PeonConfig;
  modelClient?: MemoryModelClient;
}

/** The model server took too long for this request. A smaller chunk may fit. */
export class ModelTimeoutError extends Error {
  override name = "ModelTimeoutError";
}

/** The model server's context window cut the prompt. A smaller chunk may fit. */
export class PromptTruncatedError extends Error {
  override name = "PromptTruncatedError";
}

// ── Adaptive chunk size ───────────────────────────────────────────────────────────────
// A chunk too big for the model setup (too slow for the time limit, or longer than the
// context window) failed at the same size on every retry: consolidation stalled for good.
// Halve it after such a failure, down to a floor, and grow it back 25% per success.
const MIN_ADAPTIVE_DELTA_CHARS = 8_000;

function shrunkDeltaCap(current: number): number {
  return Math.max(MIN_ADAPTIVE_DELTA_CHARS, Math.floor(current / 2));
}

/** The next cap after a success; undefined once it is back to the configured size. */
function grownDeltaCap(current: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  const next = Math.floor(current * 1.25);
  return next >= defaultMaxDeltaChars() ? undefined : next;
}

// ── Consolidation scheduling ─────────────────────────────────────────────────────────
// One consolidation per project at a time. Model requests themselves go through the shared
// slot pool in model-slots.ts, so runs for different projects interleave their model calls
// instead of stacking generations inside one local server.
// The model call sits outside store.runExclusive, so without this every hook trigger
// (session_end, turn_end, subagent_end) started its own run on the SAME unconsumed chunk, and
// several projects' backlogs queued inside one local model server, where a request waiting
// past Node fetch's 300 s header timeout failed. Module-level because tools.ts builds a new
// processor per call. Keyed by the resolved project path: the daemon canonicalizes paths
// before triggering, so every trigger for a project arrives with the same spelling.

/** Runs that are queued or running, by project. Present means "this backlog is being handled". */
const consolidationsInFlight = new Map<string, Promise<unknown>>();
function consolidationKey(projectPath: string): string {
  return resolve(projectPath);
}

/** Test hook: forget in-flight runs and the model slot pool. */
export function resetConsolidationScheduling(): void {
  consolidationsInFlight.clear();
  resetModelSlots();
}

export class PeonMemoryProcessor {
  private readonly config: PeonConfig;
  private readonly modelClient: MemoryModelClient;

  constructor(options: PeonMemoryProcessorOptions = {}) {
    this.config = options.config ?? loadPeonConfig();
    this.modelClient = options.modelClient ?? new OpenRouterMemoryModelClient();
  }

  /**
   * Consolidate the next chunk of this project's session log. A call that arrives while
   * another run for the project is queued or running waits for it, then takes the NEXT
   * chunk (the cursor has moved), so nothing is applied twice.
   */
  async processMemory(input: ProcessMemoryInput): Promise<ProcessMemoryResult> {
    const key = consolidationKey(input.projectPath);
    for (let prior = consolidationsInFlight.get(key); prior; prior = consolidationsInFlight.get(key)) {
      await prior.catch(() => undefined);
    }
    // Registered synchronously after the loop, so a concurrent caller always sees it.
    const run = this.consolidate(input);
    consolidationsInFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (consolidationsInFlight.get(key) === run) consolidationsInFlight.delete(key);
    }
  }

  private async consolidate(input: ProcessMemoryInput): Promise<ProcessMemoryResult> {
    const store = await PeonMemoryStore.open({
      projectPath: input.projectPath,
      memoryDirName: this.config.memoryDirName
    });
    const priorState = await store.readProcessingState();
    // Consolidate only NEW experience (the delta), aware of EXISTING beliefs.
    const deltaCap = priorState.adaptiveMaxDeltaChars; // undefined = the configured size
    const { text: deltaMemory, lastEventId, capped } = await store.readRawMemoryDelta(
      priorState.lastProcessedEventId,
      deltaCap
    );
    const existingMemory = formatExistingMemory(await store.listMemoryRecords());
    const fullRawChars = (await store.readRawMemory(Number.MAX_SAFE_INTEGER)).length;
    const reason = input.reason ?? "manual";

    const modelResult = input.aiResult
      ? {
          content: JSON.stringify(input.aiResult),
          model: "manual-ai-result",
          estimatedTokens: 0
        }
      : await withModelSlot(this.config, () =>
          this.modelClient.processMemory({ rawMemory: deltaMemory, existingMemory, config: this.config, reason })
        ).catch(async (error: unknown) => {
            if (error instanceof ModelTimeoutError || error instanceof PromptTruncatedError) {
              const current = deltaCap ?? defaultMaxDeltaChars();
              const next = shrunkDeltaCap(current);
              if (next < current) {
                await store.writeProcessingState({ ...(await store.readProcessingState()), adaptiveMaxDeltaChars: next });
              }
            }
            throw error;
          });

    const processed = parseProcessedMemory(modelResult.content);
    // Model-grade DOMAIN entity extraction (people/papers/methods/datasets) over the new beliefs —
    // OUTSIDE the lock (it's a network call). Merged with the deterministic resolver in apply.
    // No-ops (empty map) when AI is off / no key, so tests + offline keep the deterministic path.
    const beliefContents = [
      ...processed.decisions, ...processed.preferences, ...processed.openQuestions,
      ...processed.artifacts, ...processed.timeline, ...(processed.memories ?? []).map((m) => m.content)
    ].filter((c): c is string => typeof c === "string" && c.trim().length > 0);
    const modelEntities = await extractDomainEntitiesViaModel(
      [...new Set(beliefContents)].map((c) => ({ key: c.trim(), content: c })),
      { config: this.config }
    );
    // Whole apply→merge→persist runs as ONE serialized transaction so an overlapping
    // consolidation (turn-end vs session-end vs heartbeat) can't lost-update the brain.
    // The LLM calls above are intentionally OUTSIDE the lock — only the write section serializes.
    const { applyStats, merged } = await store.runExclusive(async () => {
      const applyStats = await store.applyProcessedMemory(processed, { reason }, modelEntities);
      const quality = createQualityReport(await store.listMemoryRecords());
      // Collapse near-duplicate active beliefs (e.g. a supersede replacement and a
      // paraphrase the model also dropped into decisions[]) into a single truth.
      const { records: curated, merged } = await store.mergeSimilarActiveRecords(quality.records);
      await store.replaceMemoryRecords(curated);
      // Persist the POST-merge report — the pre-merge one overcounts and references merged-away ids.
      await store.writeQualityReport(merged > 0 ? createQualityReport(curated) : quality);
      return { applyStats, merged };
    });

    const stats: ConsolidationStats = {
      operationsEmitted: (processed.operations ?? []).length,
      superseded: applyStats.superseded,
      obsoleted: applyStats.obsoleted,
      recordsAdded: applyStats.added,
      merged
    };

    await store.writeProcessingState({
      ...(await store.readProcessingState()),
      lastStatus: "processed",
      lastTrigger: reason,
      lastReason: reason,
      lastProcessedAt: new Date().toISOString(),
      // When the delta was capped we consumed only a chunk — advance the EVENT cursor to the chunk
      // boundary (below) but DON'T advance the char-gate, so the next trigger keeps draining the
      // backlog instead of deciding "nothing new".
      lastProcessedRawChars: capped ? (priorState.lastProcessedRawChars ?? 0) : fullRawChars,
      lastRawChars: fullRawChars,
      lastProcessedEventId: lastEventId ?? priorState.lastProcessedEventId,
      adaptiveMaxDeltaChars: grownDeltaCap(deltaCap),
      lastModel: modelResult.model,
      lastEstimatedTokens: modelResult.estimatedTokens,
      lastOperationsEmitted: stats.operationsEmitted,
      lastSuperseded: stats.superseded,
      lastObsoleted: stats.obsoleted,
      lastMerged: stats.merged
    });

    return {
      status: "processed",
      model: modelResult.model,
      estimatedTokens: modelResult.estimatedTokens,
      applied: processed,
      stats,
      capped
    };
  }

  async maybeProcessMemory(input: MaybeProcessMemoryInput): Promise<MaybeProcessMemoryResult> {
    // A run for this project is already queued or running and will consume this backlog.
    // Answer at once and leave processing-state alone: the read-modify-write below could land
    // on top of the running job's cursor write and roll it back.
    const key = consolidationKey(input.projectPath);
    if (consolidationsInFlight.has(key)) return this.inProgress(input);

    const store = await PeonMemoryStore.open({
      projectPath: input.projectPath,
      memoryDirName: this.config.memoryDirName
    });
    const rawMemory = await store.readRawMemory(Number.MAX_SAFE_INTEGER);
    const state = await store.readProcessingState();
    const decision = decideProcessing({
      rawChars: rawMemory.length,
      lastProcessedRawChars: state.lastProcessedRawChars ?? 0,
      flushMinChars: this.config.flushMinChars,
      trigger: input.trigger,
      force: input.force ?? false,
      aiMode: this.config.aiMode,
      // A local provider (Ollama) needs no key. Gating on openRouterApiKey here meant a
      // fully-local setup skipped every automatic consolidation as "missing_api_key".
      hasApiKey: llmEnabled(this.config),
      hasManualAiResult: Boolean(input.aiResult)
    });

    if (decision.action === "skip") {
      await store.writeProcessingState({
        ...state,
        lastStatus: state.lastProcessedRawChars ? state.lastStatus : "skipped",
        lastTrigger: input.trigger,
        lastReason: state.lastProcessedRawChars ? state.lastReason : decision.reason,
        lastRawChars: rawMemory.length,
        lastSkippedAt: new Date().toISOString(),
        lastSkipReason: decision.reason
      });
      return { status: "skipped", decision };
    }

    // Re-check with no await before processMemory registers: of several triggers fired in the
    // same tick, only the first to get here starts a run.
    if (consolidationsInFlight.has(key)) return this.inProgress(input);
    const result = await this.processMemory({
      projectPath: input.projectPath,
      reason: `auto:${input.trigger}:${decision.reason}`,
      aiResult: input.aiResult
    });
    await store.writeProcessingState({
      ...(await store.readProcessingState()),
      lastStatus: "processed",
      lastTrigger: input.trigger,
      lastReason: decision.reason,
      lastProcessedAt: new Date().toISOString(),
      // Don't slam the char-gate shut if only a capped chunk was consumed — the event cursor
      // (written by processMemory) advanced, but the remaining backlog must still re-trigger.
      lastProcessedRawChars: result.capped ? (state.lastProcessedRawChars ?? 0) : rawMemory.length,
      lastRawChars: rawMemory.length,
      lastModel: result.model,
      lastEstimatedTokens: result.estimatedTokens
    });

    return {
      status: "processed",
      decision,
      result
    };
  }

  /** The answer for a trigger that arrives while this project's backlog is already being handled. */
  private inProgress(input: MaybeProcessMemoryInput): MaybeProcessMemoryResult {
    return {
      status: "skipped",
      decision: {
        action: "skip",
        reason: "in_progress",
        trigger: input.trigger,
        rawChars: 0, // deliberately not read: the running job owns this project's state
        newChars: 0,
        flushMinChars: this.config.flushMinChars,
        estimatedTokens: 0
      }
    };
  }
}

export function decideProcessing(input: {
  rawChars: number;
  lastProcessedRawChars: number;
  flushMinChars: number;
  trigger: string;
  force: boolean;
  aiMode: PeonConfig["aiMode"];
  hasApiKey: boolean;
  hasManualAiResult: boolean;
}): ProcessingDecision {
  const newChars = Math.max(0, input.rawChars - input.lastProcessedRawChars);
  const base = {
    trigger: input.trigger,
    rawChars: input.rawChars,
    newChars,
    flushMinChars: input.flushMinChars,
    estimatedTokens: estimateTokensByChars(newChars)
  };

  if (input.rawChars === 0) {
    return { ...base, action: "skip", reason: "empty_memory" };
  }
  if (!input.force && newChars < input.flushMinChars) {
    return { ...base, action: "skip", reason: "below_threshold" };
  }
  if (input.aiMode === "off" && !input.hasManualAiResult) {
    return { ...base, action: "skip", reason: "ai_disabled" };
  }
  if (!input.hasApiKey && !input.hasManualAiResult) {
    return { ...base, action: "skip", reason: "missing_api_key" };
  }
  return { ...base, action: "process", reason: input.force ? "forced" : "threshold_reached" };
}

export class OpenRouterMemoryModelClient implements MemoryModelClient {
  async processMemory(input: { rawMemory: string; existingMemory?: string; config: PeonConfig; reason: string }): Promise<MemoryModelResult> {
    if (input.config.aiMode === "off") {
      throw new Error("Peon AI processing is disabled by PEON_AI_MODE=off.");
    }
    if (!input.config.llmApiKey && input.config.provider !== "ollama") {
      throw new Error("An LLM API key is required for Peon AI processing (PEON_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY).");
    }
    if (!input.rawMemory.trim()) {
      return {
        content: JSON.stringify(emptyProcessedMemory("No new session activity to consolidate.")),
        model: input.config.processingModel,
        estimatedTokens: 0
      };
    }

    const systemPrompt = buildSystemPrompt();
    const userBlocks = [`Processing reason: ${input.reason}`];
    if (input.existingMemory && input.existingMemory.trim()) {
      userBlocks.push(
        "",
        "## Existing durable memory — reference these exact ids in any operation:",
        input.existingMemory.trim()
      );
    }
    userBlocks.push("", "## New session log (the delta to consolidate):", input.rawMemory);
    const userPrompt = userBlocks.join("\n");

    if (input.config.provider === "anthropic") return anthropicProcess(input, systemPrompt, userPrompt);
    const response = await requestModel(input.config, input.config.llmBaseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.llmApiKey ?? ""}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.config.processingModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.1,
        // Reserve explicit output room. Without this, OpenRouter applies the provider's default
        // completion cap, which — paired with the delta cap on the input side — keeps the JSON
        // reply from truncating mid-object. Env-tunable for very large brains.
        // Force a JSON-object reply. A hosted model usually obeys "reply with JSON" from
        // the prompt alone; a local 7B often answers conversationally instead ("It sounds
        // like..."), which fails the parse and loses the whole consolidation. Ollama and
        // the OpenAI API both honour this flag, so ask for it rather than trusting prose.
        response_format: { type: "json_object" },
        max_tokens: Number(process.env.PEON_CONSOLIDATION_MAX_TOKENS) || 8192
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter memory processing failed with ${response.status}${body ? `: ${body}` : ""}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number };
    };

    // A server whose context window is smaller than this prompt does not error: it
    // keeps only the TAIL and silently drops the rest — which is the system prompt and
    // the JSON schema. The model then answers without its instructions, and the result
    // is empty or wrong. Refuse it rather than mark the session as consolidated.
    const estimatedPromptTokens =
      estimatePromptTokensForTruncation(systemPrompt) + estimatePromptTokensForTruncation(userPrompt);
    const reportedPromptTokens = json.usage?.prompt_tokens;
    if (detectPromptTruncation(estimatedPromptTokens, reportedPromptTokens)) {
      throw new PromptTruncatedError(
        `The model server truncated the consolidation prompt: it processed ${reportedPromptTokens} tokens ` +
          `of roughly ${estimatedPromptTokens} sent. Its context window is too small, so the instructions and ` +
          `schema were cut off and the result would be empty. The session log was NOT consumed and will be ` +
          `retried. Fix: give the model a larger context window — for Ollama, create a model with ` +
          `"PARAMETER num_ctx 32768" (or set OLLAMA_CONTEXT_LENGTH) and point PEON_PROCESSING_MODEL at it.`
      );
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter memory processing response did not include content.");

    return {
      content,
      model: input.config.processingModel,
      estimatedTokens: estimateTokens(systemPrompt) + estimateTokens(userPrompt) + estimateTokens(content)
    };
  }
}

export function parseProcessedMemory(content: string): ProcessedMemory {
  const jsonText = extractJson(content);
  // Throws on genuinely-unparseable output ON PURPOSE: the caller (processMemory) lets it
  // propagate so the delta cursor is NOT advanced past data that was never consolidated — the
  // batch is retried next run instead of being silently lost. The 500 that this used to surface
  // to the SessionEnd hook is absorbed at the daemon boundary (runAutomaticProcessing logs an
  // auto_process_fail and returns a failed result instead of re-throwing).
  const parsed = JSON.parse(jsonText) as Partial<ProcessedMemory> & { global?: unknown };
  // Cross-cutting knowledge the model flagged becomes scope-"global" fact records,
  // so it gets lifted into global memory after consolidation.
  const globalRecords: MemoryRecordInput[] = stringArray(parsed.global).map((content) => ({
    type: "fact" as const,
    content,
    scope: "global" as const
  }));
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    decisions: stringArray(parsed.decisions),
    preferences: stringArray(parsed.preferences),
    openQuestions: stringArray(parsed.openQuestions),
    artifacts: stringArray(parsed.artifacts),
    timeline: stringArray(parsed.timeline),
    memories: [...memoryRecordInputs(parsed.memories), ...globalRecords],
    operations: operationInputs(parsed.operations)
  };
}

/** Render the active durable memory the model reconciles against (id | type | content). */
function formatExistingMemory(records: MemoryRecord[], limit = 40): string {
  const active = records.filter((record) => record.status === "active");
  if (active.length === 0) return "";
  return active
    .slice()
    .sort((left, right) => right.score.importance - left.score.importance)
    .slice(0, limit)
    .map((record) => `${record.id} | ${record.type} | ${record.content}`)
    .join("\n");
}

/** Sanitize consolidation operations; drop anything malformed (degrade to add-only). */
function operationInputs(value: unknown): ConsolidationOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConsolidationOperation[] => {
    if (!item || typeof item !== "object") return [];
    const op = item as { op?: unknown; targetId?: unknown; reason?: unknown; replacement?: unknown };
    if (typeof op.targetId !== "string" || !op.targetId.trim()) return [];
    const reason = typeof op.reason === "string" ? op.reason : undefined;
    if (op.op === "obsolete") {
      return [{ op: "obsolete", targetId: op.targetId, reason }];
    }
    if (op.op === "supersede") {
      const [replacement] = memoryRecordInputs([op.replacement]);
      if (!replacement) return [];
      return [{ op: "supersede", targetId: op.targetId, reason, replacement }];
    }
    return [];
  });
}

function isJsonObject(candidate: string): boolean {
  try {
    return JSON.parse(candidate) !== null && typeof JSON.parse(candidate) === "object";
  } catch {
    return false;
  }
}

function extractJson(content: string): string {
  const trimmed = content.trim();
  // Models wrap the JSON in a ```json fence (or, in the wild, a ''' triple-single-quote fence),
  // sometimes with prose around it, sometimes after a worked EXAMPLE block, and a fence can even
  // appear inside a string value. So: collect every fenced block and return the LAST one whose body
  // actually parses as a JSON object — never blindly grab the first fence (that lazily captured an
  // example or a ``` inside a string and turned previously-working input into a parse failure).
  // Accept both fence markers because some models emit '''json instead of ```json, which used to
  // fall through to the brace-slice fallback and 500 when an EXAMPLE block was also present.
  const fences = [...trimmed.matchAll(/(?:```|''')(?:json)?\s*([\s\S]*?)(?:```|''')/gi)].map((m) => m[1].trim());
  for (let i = fences.length - 1; i >= 0; i--) {
    if (isJsonObject(fences[i])) return fences[i];
  }
  // No parseable fenced block: fall back to the outermost brace slice. This recovers both a bare
  // JSON object surrounded by prose AND an object whose own string values contain literal ```.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return trimmed.slice(firstBrace, lastBrace + 1);
  return trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function memoryRecordInputs(value: unknown): MemoryRecordInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MemoryRecordInput[] => {
    if (!item || typeof item !== "object") return [];
    const input = item as Partial<MemoryRecordInput>;
    if (!isMemoryType(input.type) || typeof input.content !== "string" || input.content.trim().length === 0) return [];
    return [
      {
        type: input.type,
        content: input.content,
        scope: input.scope === "global" || input.scope === "session" || input.scope === "project" ? input.scope : undefined,
        importance: typeof input.importance === "number" ? input.importance : undefined,
        confidence: typeof input.confidence === "number" ? input.confidence : undefined,
        entities: Array.isArray(input.entities) ? input.entities.filter((entity): entity is string => typeof entity === "string") : undefined,
        status: isMemoryStatus(input.status) ? input.status : undefined
      }
    ];
  });
}

function isMemoryType(value: unknown): value is MemoryType {
  return (
    value === "summary" ||
    value === "decision" ||
    value === "preference" ||
    value === "open_question" ||
    value === "artifact" ||
    value === "timeline" ||
    value === "fact"
  );
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return value === "active" || value === "stale" || value === "conflicted" || value === "superseded" || value === "archived";
}

const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/**
 * POST a consolidation request with an explicit deadline (PEON_LLM_TIMEOUT_MS, default
 * 600 s) and errors that say what happened. Plain fetch reported every failure as
 * "fetch failed". Every failure here throws before apply, so the session log is kept.
 *
 * Node's fetch also gives up by itself if no response headers arrive within 300 s. A
 * non-streaming completion sends headers only when it is done, so that is the practical
 * cap on one consolidation call: minutes-long local generations fit only while one model
 * server isn't also serving other consolidations, which is what the slot pool ensures.
 */
async function requestModel(config: PeonConfig, url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = describeModelRequestFailure(error, url, timeoutMs);
    const code = (error as { cause?: { code?: string } }).cause?.code;
    const timedOut = (error instanceof Error && error.name === "TimeoutError") || code === "UND_ERR_HEADERS_TIMEOUT";
    throw timedOut ? new ModelTimeoutError(message) : new Error(message);
  }
}

function describeModelRequestFailure(error: unknown, url: string, timeoutMs: number): string {
  const kept = "The session log was NOT consumed and will be retried.";
  const slow =
    "A local model server may be busy with other requests, or too slow for this chunk size " +
    "(PEON_CONSOLIDATION_MAX_DELTA_CHARS).";
  if (error instanceof Error && error.name === "TimeoutError") {
    return `The consolidation model did not answer within ${timeoutMs / 1000} s (PEON_LLM_TIMEOUT_MS). ${kept} ${slow}`;
  }
  const code = (error as { cause?: { code?: string } }).cause?.code;
  if (code === "UND_ERR_HEADERS_TIMEOUT") {
    return `The model server sent no response within 300 s, Node's fetch limit for response headers. ${kept} ${slow}`;
  }
  const reason = code ?? (error instanceof Error ? error.message : String(error));
  return `Could not reach the model server at ${new URL(url).origin} (${reason}). ${kept}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Did the model server silently truncate the prompt?
 *
 * OpenAI-compatible servers report usage.prompt_tokens: what the model actually read.
 * Ollama, at its 4096-token default, reports exactly 4096 for a ~17K-token prompt.
 *
 * The estimate comes from estimatePromptTokensForTruncation, and the threshold has to
 * respect how rough it is. For English that estimate is chars/4, which OVER-estimates
 * (real text runs ~5.5 chars/token), so an untruncated prompt still reports ~0.73 of
 * it. A truncated one reports ~0.24. Below 0.5 is unambiguous: reaching it without
 * truncation would take 8+ chars per token. Small prompts are ignored, where
 * estimation noise is a large share of the total.
 */
export function detectPromptTruncation(
  estimatedPromptTokens: number,
  reportedPromptTokens: number | undefined
): boolean {
  if (!reportedPromptTokens || reportedPromptTokens <= 0) return false; // no usage reported: cannot tell
  if (estimatedPromptTokens - reportedPromptTokens < 1000) return false;
  return reportedPromptTokens / estimatedPromptTokens < 0.5;
}

/** Scripts that tokenize at roughly one token per character or more, not one per word. */
const TOKEN_DENSE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\uFF00-\uFFEF]/u;
const TOKENS_PER_ASCII_CHAR = 1 / 4;
const TOKENS_PER_DENSE_CHAR = 0.75;
const TOKENS_PER_OTHER_CHAR = 0.35;

/**
 * Prompt size estimate for detectPromptTruncation ONLY. estimateTokens (chars/4) stays
 * the cost/reporting estimate; this one exists because chars/4 undercounts token-dense
 * scripts, which let a truncated CJK prompt pass as untruncated.
 *
 * The detector flags reported/estimated < 0.5, so each weight has to sit between two
 * limits: high enough that a truncated prompt falls below 0.5, and at most ~2x the
 * MOST efficient tokenizer's rate, or an untruncated prompt falls below 0.5 too. That
 * false positive is the worse failure: the session is refused on every retry.
 *
 * - ASCII, 1/4 per char: unchanged, so English behaves exactly as before (chars/4
 *   over-counts English ~1.4x; measured untruncated ratio 0.73, truncated 0.24).
 * - Han, kana, hangul, bopomofo, CJK and fullwidth punctuation, 0.75 per char: efficient
 *   tokenizers run ~0.45-0.6 tokens per CJK char, giving an untruncated ratio of 0.6-0.8.
 *   Qwen2.5 on Ollama runs ~0.65, so a truncated CJK prompt now reads well under 0.5.
 * - Any other non-ASCII, 0.35 per char: Cyrillic, Greek, Arabic, accented Latin and the
 *   like pack into ~0.22-0.35 tokens per char on large-vocabulary tokenizers. A flat 0.75
 *   here would read an untruncated Russian log at ~0.31 and block it forever.
 *
 * Iterates code points, so an astral character (CJK Extension B, emoji) counts once.
 */
export function estimatePromptTokensForTruncation(text: string): number {
  // Count per class and multiply once: summing 0.35 thousands of times drifts past the
  // integer and Math.ceil would round it up.
  let ascii = 0;
  let dense = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) < 0x80) ascii += 1;
    else if (TOKEN_DENSE_SCRIPT.test(char)) dense += 1;
    else other += 1;
  }
  const tokens = ascii * TOKENS_PER_ASCII_CHAR + dense * TOKENS_PER_DENSE_CHAR + other * TOKENS_PER_OTHER_CHAR;
  return Math.max(1, Math.ceil(tokens));
}

function estimateTokensByChars(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function emptyProcessedMemory(summary: string): ProcessedMemory {
  return {
    summary,
    decisions: [],
    preferences: [],
    openQuestions: [],
    artifacts: [],
    timeline: []
  };
}

/** Anthropic Messages API adapter — same contract as the OpenAI-compatible path. */
async function anthropicProcess(
  input: { rawMemory: string; existingMemory?: string; config: PeonConfig; reason: string },
  systemPrompt: string,
  userPrompt: string
): Promise<MemoryModelResult> {
  const response = await requestModel(input.config, input.config.llmBaseUrl.replace(/\/$/, "") + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.config.llmApiKey ?? "",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.config.processingModel,
      max_tokens: Number(process.env.PEON_CONSOLIDATION_MAX_TOKENS) || 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic memory processing failed with ${response.status}${body ? `: ${body}` : ""}`);
  }
  const json = (await response.json()) as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const content = (json.content ?? []).map((c) => c.text ?? "").join("");
  const estimatedTokens = (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0);
  return { content, model: input.config.processingModel, estimatedTokens };
}

function buildSystemPrompt(): string {
  return `You are Peon, a local-first memory processor for AI coding and research sessions.

Your job: read a raw session log and extract ONLY durable, high-signal memory worth preserving across future sessions.

## Output Format
Return ONLY a valid JSON object with exactly these keys:

{
  "summary": "2-4 sentence narrative of what happened and what was learned. Must be useful to a future AI reading this cold.",
  "decisions": ["array of firm decisions made — what was chosen and why, in one sentence each"],
  "preferences": ["user workflow preferences, style choices, tooling preferences discovered"],
  "openQuestions": ["unresolved questions, blockers, things still being figured out"],
  "artifacts": ["important files created/modified — include path and purpose, e.g. 'peon-mcp/src/daemon.ts: background HTTP daemon for memory operations'"],
  "timeline": ["key events in chronological order: what was attempted, what succeeded, what failed"],
  "global": ["cross-cutting knowledge that applies to ALL of the user's projects, not just this one — see rules below"],
  "operations": []
}

## Rules
THE SIGNAL TEST governs every item: before emitting ANY belief, ask "will this still matter in a month, in a different session?" If no, drop it. A short empty result is better than noise.

- decisions: a durable CHOICE that shapes future work — an architecture/approach/tool selection, or a confirmed result/metric (e.g. "DTS-SQL hits 60.31% on BIRD"). Include rationale when present. NOT a one-time setup/operational ACTION — cloning a repo, installing deps, creating a directory, downloading weights, submitting/monitoring a job, confirming a job is pending, adding a warning filter. Those are ephemeral; EXCLUDE them.
- preferences: a STABLE working style the user will carry into FUTURE sessions ("prefers TDD", "wants terse updates", "always local-first"). NOT a one-off instruction for this task, and NOT a transient setting. If it only applies to this single session, drop it.
- openQuestions: genuinely unresolved AND still open at the END of this log, with enough context to resume. If the log later answers or abandons it, do NOT emit it.
- artifacts: files CENTRAL to the project's future (source modules, configs, key datasets/outputs) with "path: one-line purpose". Skip temp files, logs, scratch, and files merely read.
- timeline: 3-8 entries, non-obvious turning points only (a bug's root cause, an approach abandoned and why, an emergent decision). Skip routine steps.
- summary: 2-4 factual sentences for a reader with ZERO context — name the project, the goal, and the key outcome/state. No filler, no "the user asked".
- global: knowledge reusable across ALL the user's projects — compute environment (clusters, GPUs, hostnames, scratch paths), accounts/services, reusable references (dataset/doc locations), durable facts about the user and their tooling. EXCLUDE this project's OWN internals (its code, files, architecture, decisions) even when they sound general. Each item self-contained and usable cold in an UNRELATED project. Else [].

## Hard constraints
- Output ONLY the JSON object — no markdown fences, no prose before or after it.
- Do NOT invent facts. A category with nothing durable → [].
- DEDUP: never emit two items that state the same fact in different words — keep exactly one.
- FIDELITY: preserve concrete specifics VERBATIM — exact numbers/metrics, proper names, enumerated steps, file/command/flag names. Do NOT generalize them away: keep "AskData hits 74% on BIRD; step 4 rewrites the NL to hide the predicate via GROUP BY", never "a method performs well". The specifics are what make a belief actionable; a vague gist is near-useless.
- Concise on the GIST, complete on the SPECIFICS: decisions/preferences ≤ 300 chars (use the room for the specifics above, not filler), timeline entries ≤ 150 chars.

## Integrative Consolidation (reconcile, don't just append)
You may be shown an "Existing durable memory" block: lines of "id | type | content". These are beliefs already recorded. For each new belief in the session log, decide whether it is brand-new or whether it CHANGES an existing record, and use the "operations" array to reconcile:

- If a new belief REPLACES or PARTIALLY CONTRADICTS an existing record, emit a "supersede" op referencing that record's EXACT id, and put the full reconciled current truth in "replacement".
  CRITICAL: the replacement IS the new record. Do NOT also repeat that belief in "decisions"/"preferences"/"memories" — that creates a duplicate. Each belief goes in exactly ONE place: an add channel OR a supersede replacement, never both.
  { "op": "supersede", "targetId": "<exact id from existing memory>", "reason": "why it changed", "replacement": { "type": "decision", "content": "the new current truth" } }
- If an existing belief is simply no longer true and has no successor, emit "obsolete":
  { "op": "obsolete", "targetId": "<exact id>", "reason": "why it's no longer true" }
- Only reference ids that appear VERBATIM in the existing memory block. NEVER invent an id. If you are unsure whether something supersedes an existing record, prefer a plain add (leave operations empty for it).
- If nothing in existing memory changed, return "operations": [].

### Worked example
Existing durable memory:
  mem_decision_4f1a9c22 | decision | Use OpenRouter for everything.
New session log says: the team is moving embeddings to a local Ollama model.
Correct output includes:
  "operations": [
    { "op": "supersede", "targetId": "mem_decision_4f1a9c22", "reason": "embeddings moved to local Ollama",
      "replacement": { "type": "decision", "content": "OpenRouter for chat and processing; embeddings on local Ollama (supersedes the original all-OpenRouter decision)." } }
  ]
and does NOT repeat that decision in the "decisions" array.`;
}
