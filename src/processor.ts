import { PeonMemoryStore } from "./memory-store.js";
import { loadPeonConfig, type PeonConfig } from "./config.js";
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
  reason: "forced" | "threshold_reached" | "below_threshold" | "ai_disabled" | "missing_api_key" | "empty_memory";
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

export class PeonMemoryProcessor {
  private readonly config: PeonConfig;
  private readonly modelClient: MemoryModelClient;

  constructor(options: PeonMemoryProcessorOptions = {}) {
    this.config = options.config ?? loadPeonConfig();
    this.modelClient = options.modelClient ?? new OpenRouterMemoryModelClient();
  }

  async processMemory(input: ProcessMemoryInput): Promise<ProcessMemoryResult> {
    const store = await PeonMemoryStore.open({
      projectPath: input.projectPath,
      memoryDirName: this.config.memoryDirName
    });
    const priorState = await store.readProcessingState();
    // Consolidate only NEW experience (the delta), aware of EXISTING beliefs.
    const { text: deltaMemory, lastEventId, capped } = await store.readRawMemoryDelta(priorState.lastProcessedEventId);
    const existingMemory = formatExistingMemory(await store.listMemoryRecords());
    const fullRawChars = (await store.readRawMemory(Number.MAX_SAFE_INTEGER)).length;
    const reason = input.reason ?? "manual";

    const modelResult = input.aiResult
      ? {
          content: JSON.stringify(input.aiResult),
          model: "manual-ai-result",
          estimatedTokens: 0
        }
      : await this.modelClient.processMemory({ rawMemory: deltaMemory, existingMemory, config: this.config, reason });

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
      hasApiKey: Boolean(this.config.openRouterApiKey),
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
    const response = await fetch(input.config.llmBaseUrl.replace(/\/$/, "") + "/chat/completions", {
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
        max_tokens: Number(process.env.PEON_CONSOLIDATION_MAX_TOKENS) || 8192
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter memory processing failed with ${response.status}${body ? `: ${body}` : ""}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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
  const response = await fetch(input.config.llmBaseUrl.replace(/\/$/, "") + "/v1/messages", {
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
