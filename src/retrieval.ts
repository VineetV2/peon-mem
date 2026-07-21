import { cosineSimilarity, type EmbeddingVector } from "./embeddings.js";
import { canonicalizeEntity } from "./entities.js";
import type { MemoryRecord, MemoryType } from "./types.js";

export type RetrievalReasonKind =
  | "query_term"
  | "entity"
  | "file"
  | "type"
  | "quality"
  | "recency"
  | "status"
  | "semantic";

export interface RetrievalReason {
  kind: RetrievalReasonKind;
  label: string;
  score: number;
}

export interface RankedMemoryRecord {
  record: MemoryRecord;
  score: number;
  reasons: RetrievalReason[];
  explanation: string;
}

export interface SemanticRetrievalInput {
  /** Embedding of the query string. */
  queryVector: EmbeddingVector;
  /** Record id → its stored embedding vector. */
  vectorById: Map<string, EmbeddingVector>;
  /** How strongly cosine similarity counts toward the final score. Default 6. */
  weight?: number;
  /** Cosine similarities below this contribute nothing (filters noise). Default 0.15. */
  minSimilarity?: number;
}

export interface RetrievalOptions {
  now?: Date | string | number;
  limit?: number;
  typeWeights?: Partial<Record<MemoryType, number>>;
  /** When provided (and a query is given), blends semantic similarity into ranking. */
  semantic?: SemanticRetrievalInput;
  /** Per-record entity-graph activation (id → score). Fused as a signal AND admits an
   *  associatively-activated belief through the relevance gate, so a strong association can
   *  enter the top-K instead of being appended after the direct hits. See computeGraphActivation. */
  graphActivation?: Map<string, number>;
}

const DEFAULT_MIN_SIMILARITY = 0.15;

export interface ContextSelectionOptions {
  maxChars: number;
  recordFormatter?: (item: RankedMemoryRecord) => string;
}

export interface ContextSelection {
  records: RankedMemoryRecord[];
  omitted: RankedMemoryRecord[];
  totalChars: number;
  maxChars: number;
}

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "with"
]);

const RRF_K = 60; // standard reciprocal-rank-fusion constant
const PIN_BOOST = 0.05;
// Associative graph signal weight (fraction of a direct RRF signal), for the OPT-IN expandGraph
// path only. Default 0.1: the labeled eval showed higher weights hurt top-K relevance (0.5 →
// −2.9% Recall@10, 1.0 → −3.8%) while ~0.1 is neutral. Env-tunable (PEON_GRAPH_WEIGHT) for sweeps.
const GRAPH_FUSION_WEIGHT = (() => {
  const env = process.env.PEON_GRAPH_WEIGHT;
  return env !== undefined && Number.isFinite(Number(env)) ? Number(env) : 0.1;
})();

// Type priority is a PRIOR vote in the fusion (durable types over ephemeral) — a
// rank, not a hand-tuned weight, so it stays robust alongside the other signals.
const TYPE_PRIORITY: Record<MemoryType, number> = {
  decision: 6, preference: 5, fact: 4, artifact: 3, summary: 2, open_question: 1, timeline: 0
};

interface RecordSignals {
  record: MemoryRecord;
  index: number;
  lexical: number;
  semantic: number;
  quality: number;
  recency: number;
  strength: number;
  graph: number;
  reasons: RetrievalReason[];
}

/**
 * Hybrid retrieval by Reciprocal Rank Fusion. Each signal (lexical, semantic,
 * quality, recency, reinforcement strength) ranks the relevance-gated candidates
 * independently; we fuse by Σ 1/(k+rank). RRF is weight-free — it removes the
 * fragile hand-tuned score constants by comparing RANKS, which are commensurable
 * across signals where raw scores are not. Pinned beliefs are boosted; archived/
 * superseded are excluded by default (they are the long-term tier, not working memory).
 */
export function rankMemoryRecords(
  records: MemoryRecord[],
  query: string | undefined,
  options: RetrievalOptions = {}
): RankedMemoryRecord[] {
  const terms = queryTerms(query);
  const fileTerms = queryFileTerms(query);
  const nowMs = timestamp(options.now ?? Date.now());
  const limit = Math.max(0, Math.trunc(options.limit ?? 50));
  const semantic = options.semantic;
  const minSimilarity = semantic?.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const hasQuery = terms.length > 0;

  const signals: RecordSignals[] = records.map((record, index) => {
    const reasons: RetrievalReason[] = [];
    const lexical = lexicalScore(record, terms, fileTerms, reasons);
    let semSim = 0;
    if (semantic && semantic.queryVector.length > 0) {
      const vector = semantic.vectorById.get(record.id);
      if (vector && vector.length > 0) {
        const sim = cosineSimilarity(semantic.queryVector, vector);
        if (sim >= minSimilarity) {
          semSim = sim;
          reasons.push({ kind: "semantic", label: `semantic match ${sim.toFixed(2)}`, score: roundScore(sim) });
        }
      }
    }
    const quality = clamp(record.score.importance) * 0.6 + clamp(record.score.confidence) * 0.4;
    const strength = clamp(typeof record.strength === "number" ? record.strength : record.score.importance)
      + Math.min(0.5, Math.log1p(record.recallCount ?? 0) / 6); // reinforcement bonus
    const graph = options.graphActivation?.get(record.id) ?? 0;
    if (graph > 0 && lexical === 0 && semSim === 0) {
      reasons.push({ kind: "entity", label: "linked via entity graph", score: roundScore(graph) });
    }
    return { record, index, lexical, semantic: semSim, quality, recency: recencyScore(record, nowMs), strength, graph, reasons };
  });

  // Relevance gate: with a query, keep only beliefs that matched lexically or semantically.
  // Tier filtering (active vs archived/superseded) is intentionally NOT done here — the
  // injection/context layer owns that, so it can both record WHY a belief was omitted and
  // recover history on demand (includeInactive). The ranker stays a pure relevance ranker.
  const gated = signals.filter((s) => {
    if (!hasQuery) return true;
    // Admit a belief that matched the query OR that the entity graph activated (associative recall).
    return s.lexical > 0 || s.semantic > 0 || s.graph > 0;
  });
  if (gated.length === 0) return [];

  // Build per-signal rank maps over the gated candidates.
  const lexRank = rankMap(gated, (s) => s.lexical, true);
  const semRank = rankMap(gated, (s) => s.semantic, true);
  const qualRank = rankMap(gated, (s) => s.quality, false);
  const recRank = rankMap(gated, (s) => s.recency, false);
  const strRank = rankMap(gated, (s) => s.strength, false);
  const typeRank = rankMap(gated, (s) => TYPE_PRIORITY[s.record.type] ?? 0, false);
  const graphRank = rankMap(gated, (s) => s.graph, true);

  const ranked = gated.map((s) => {
    let score = 0;
    if (s.lexical > 0) score += 1 / (RRF_K + lexRank(s));
    if (s.semantic > 0) score += 1 / (RRF_K + semRank(s));
    // Associative graph signal — DAMPED (×GRAPH_FUSION_WEIGHT) so it's secondary to direct
    // matches: a strong association can enter the top-K and displace a weak direct hit, but
    // won't outrank genuine query matches.
    if (s.graph > 0) score += GRAPH_FUSION_WEIGHT * (1 / (RRF_K + graphRank(s)));
    // Priors always participate (relevance already gated the candidate set).
    score += 1 / (RRF_K + qualRank(s));
    score += 1 / (RRF_K + recRank(s));
    score += 1 / (RRF_K + strRank(s));
    score += 1 / (RRF_K + typeRank(s));
    if (s.record.pinned) score += PIN_BOOST;
    if (s.record.status === "stale") score -= 0.01;
    if (s.record.status === "conflicted") score -= 0.005;
    const reasons = [...s.reasons,
      { kind: "quality" as const, label: `importance ${clamp(s.record.score.importance).toFixed(2)}`, score: 1 / (RRF_K + qualRank(s)) },
      { kind: "recency" as const, label: `updated ${s.record.updatedAt}`, score: 1 / (RRF_K + recRank(s)) }];
    if ((s.record.recallCount ?? 0) > 0) reasons.push({ kind: "status", label: `recalled ${s.record.recallCount}×`, score: 1 / (RRF_K + strRank(s)) });
    return {
      record: s.record,
      score: roundScore(score),
      reasons,
      explanation: s.reasons.map((r) => r.label).join("; "),
      index: s.index
    };
  });

  return ranked
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const updatedDelta = timestamp(right.record.updatedAt) - timestamp(left.record.updatedAt);
      if (updatedDelta !== 0) return updatedDelta;
      return left.index - right.index;
    })
    .slice(0, limit)
    .map(({ index: _index, ...item }) => item);
}

/**
 * Build a total rank lookup (1-based, descending by key) using COMPETITION ranking:
 * equal values share the same rank, so ties contribute equally to both records and
 * the outcome is decided by the signals that actually differ (no arbitrary tie-break).
 * Missing (gated-out) → large rank (~0 contribution).
 */
function rankMap(items: RecordSignals[], key: (s: RecordSignals) => number, gateZero: boolean): (s: RecordSignals) => number {
  const sorted = items
    .map((s) => ({ s, v: key(s) }))
    .filter((x) => (gateZero ? x.v > 0 : true))
    .sort((a, b) => b.v - a.v);
  const map = new Map<RecordSignals, number>();
  let rank = 0;
  let prev: number | undefined;
  sorted.forEach((x, i) => {
    if (prev === undefined || x.v !== prev) rank = i + 1; // ties keep the prior rank
    prev = x.v;
    map.set(x.s, rank);
  });
  const last = sorted.length + items.length + 1;
  return (s: RecordSignals) => map.get(s) ?? last;
}

function lexicalScore(record: MemoryRecord, terms: string[], fileTerms: string[], reasons: RetrievalReason[]): number {
  const text = searchableText(record);
  let score = 0;
  const matchedTerms = terms.filter((term) => text.includes(term));
  if (matchedTerms.length > 0) {
    score += matchedTerms.length * 2;
    reasons.push({ kind: "query_term", label: `matched query terms ${matchedTerms.join(", ")}`, score: matchedTerms.length * 2 });
  }
  const matchedEntities = record.entities.filter((entity) => {
    const e = entity.toLowerCase();
    return terms.some((term) => e.includes(term) || term.includes(e));
  });
  if (matchedEntities.length > 0) {
    score += matchedEntities.length * 3;
    reasons.push({ kind: "entity", label: `matched entity ${matchedEntities.join(", ")}`, score: matchedEntities.length * 3 });
  }
  const matchedFiles = record.entities.filter((entity) => isFileLike(entity) && fileTerms.some((term) => entity.toLowerCase().includes(term)));
  if (matchedFiles.length > 0) {
    score += matchedFiles.length * 4;
    reasons.push({ kind: "file", label: `matched file ${matchedFiles.join(", ")}`, score: matchedFiles.length * 4 });
  }
  return score;
}

export function selectMemoryRecordsForContext(
  rankedRecords: RankedMemoryRecord[],
  options: ContextSelectionOptions
): ContextSelection {
  const maxChars = Math.max(0, Math.trunc(options.maxChars));
  const formatter = options.recordFormatter ?? defaultRecordFormatter;
  const records: RankedMemoryRecord[] = [];
  const omitted: RankedMemoryRecord[] = [];
  let totalChars = 0;

  for (const item of rankedRecords) {
    const length = formatter(item).length;
    if (length <= maxChars - totalChars) {
      records.push(item);
      totalChars += length;
    } else {
      omitted.push(item);
    }
  }

  return { records, omitted, totalChars, maxChars };
}

/** Default trade-off: 0.7 weight on relevance, 0.3 on novelty. Tuned for coverage without losing the top hit. */
export const DEFAULT_MMR_LAMBDA = 0.7;

/**
 * Re-order ranked records by Maximal Marginal Relevance so the injected block has
 * COVERAGE instead of five paraphrases of the same belief. Each pick maximizes
 *   λ·relevance − (1−λ)·maxSimilarity(candidate, alreadyPicked)
 * Relevance is the record's existing fused score (max-normalized to [0,1] within the
 * set); similarity is lexical Jaccard over content+entity tokens — cheap, deterministic,
 * and embedding-free so it works in pure local-first mode. The single most relevant
 * record is always selected first, so the top hit is never displaced by diversification.
 */
export function diversifyByMMR(records: RankedMemoryRecord[], lambda: number = DEFAULT_MMR_LAMBDA): RankedMemoryRecord[] {
  if (records.length <= 2) return [...records];
  const λ = Math.max(0, Math.min(1, lambda));
  const maxScore = Math.max(...records.map((r) => r.score), 0);
  const rel = (item: RankedMemoryRecord) => (maxScore > 0 ? item.score / maxScore : 0);
  const tokens = records.map((r) => recordTokens(r.record));

  const remaining = records.map((_, i) => i);
  const selected: number[] = [];
  // Seed with the single most relevant record (input is already relevance-sorted).
  let best = remaining[0];
  for (const i of remaining) if (rel(records[i]) > rel(records[best])) best = i;
  selected.push(best);
  remaining.splice(remaining.indexOf(best), 1);

  while (remaining.length > 0) {
    let pick = remaining[0];
    let pickScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(tokens[i], tokens[s]);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = λ * rel(records[i]) - (1 - λ) * maxSim;
      if (mmr > pickScore) { pickScore = mmr; pick = i; }
    }
    selected.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return selected.map((i) => records[i]);
}

export interface GraphExpandOptions {
  /** How many of the top ranked records seed the activation. Default 8. */
  seedDepth?: number;
  /** Max neighbours to pull in. Default 6. */
  maxNeighbors?: number;
  /** Global decay on the 1-hop spread (keeps neighbours supplementary). Default 0.5. */
  damping?: number;
  /** Weight for code-namespace entities vs domain (file/symbol co-occurrence is weaker signal). Default 0.4. */
  codeWeight?: number;
  /** Skip entities mentioned by more than this many beliefs — super-hub hairball guard. Default 40. */
  hubDegreeCap?: number;
}

/**
 * Entity-graph spreading activation (the associative-recall layer). Lexical/semantic ranking
 * finds beliefs that match the QUERY; this finds beliefs in the ANSWER's neighbourhood by
 * spreading activation from the top hits through shared entities, with three brain-like rules
 * the old flat 1-hop expander lacked:
 *   - DISTANCE DECAY — a global damping (λ) keeps neighbours below direct matches.
 *   - MULTI-SOURCE SUMMATION — a belief lit through several shared entities (or several seeds)
 *     accumulates activation, so it outranks one lit through a single weak link.
 *   - HUB DAMPING — rare entities transmit more activation (1/log₂(2+degree)); super-hubs
 *     (e.g. a file mentioned by 80 beliefs) are skipped so the graph isn't a hairball.
 * Domain entities (people/papers/concepts) spread more than code entities. Pure + deterministic.
 * Neighbours come back with small scores in their own band and are meant to be appended AFTER
 * the direct results, never displacing them.
 */
/**
 * Raw spreading activation: id → accumulated activation for beliefs in the seeds' entity
 * neighbourhood (excluding the seeds themselves). The associative substrate, shared by the
 * fused-ranking path (passed as RetrievalOptions.graphActivation) and the legacy append path
 * (expandByEntityGraph). Excludes seed ids so direct hits aren't double-counted.
 */
export function computeGraphActivation(
  seeds: RankedMemoryRecord[],
  pool: MemoryRecord[],
  options: GraphExpandOptions = {}
): Map<string, number> {
  const seedDepth = Math.max(1, Math.trunc(options.seedDepth ?? 8));
  const damping = options.damping ?? 0.5;
  const codeWeight = options.codeWeight ?? 0.4;
  const hubDegreeCap = Math.max(1, Math.trunc(options.hubDegreeCap ?? 40));

  const active = pool.filter((record) => record.status === "active");
  const entityToRecords = new Map<string, MemoryRecord[]>();
  for (const record of active) {
    for (const e of unique(record.entities)) {
      const list = entityToRecords.get(e) ?? entityToRecords.set(e, []).get(e)!;
      list.push(record);
    }
  }

  const seedIds = new Set(seeds.map((s) => s.record.id));
  const topSeeds = seeds.slice(0, seedDepth);
  const activation = new Map<string, number>();
  if (topSeeds.length === 0) return activation;
  const maxSeedScore = Math.max(...topSeeds.map((s) => s.score), 1e-9);

  topSeeds.forEach((seed, i) => {
    const seedActivation = (seed.score > 0 ? seed.score / maxSeedScore : 0) / (1 + i * 0.3); // rank decay
    if (seedActivation <= 0) return;
    for (const e of unique(seed.record.entities)) {
      const holders = entityToRecords.get(e);
      if (!holders || holders.length > hubDegreeCap) continue; // skip super-hubs
      const ns = canonicalizeEntity(e)?.namespace ?? "code";
      const entityWeight = (ns === "domain" ? 1 : codeWeight) / Math.log2(2 + holders.length);
      for (const neighbor of holders) {
        if (seedIds.has(neighbor.id)) continue; // never re-rank a direct hit
        activation.set(neighbor.id, (activation.get(neighbor.id) ?? 0) + damping * seedActivation * entityWeight);
      }
    }
  });
  return activation;
}

/**
 * Entity-graph spreading activation, formatted as standalone neighbour records (legacy append
 * path + the unit tests). The fused-ranking path uses computeGraphActivation directly via
 * rankMemoryRecords' graphActivation option, which lets associations compete inside the top-K.
 */
export function expandByEntityGraph(
  seeds: RankedMemoryRecord[],
  pool: MemoryRecord[],
  options: GraphExpandOptions = {}
): RankedMemoryRecord[] {
  const maxNeighbors = Math.max(0, Math.trunc(options.maxNeighbors ?? 6));
  if (maxNeighbors === 0) return [];
  const activation = computeGraphActivation(seeds, pool, options);
  if (activation.size === 0) return [];
  const recordById = new Map(pool.filter((r) => r.status === "active").map((r) => [r.id, r]));
  const maxAct = Math.max(...activation.values());
  if (!(maxAct > 0)) return []; // all-zero activation (e.g. damping/codeWeight 0) → avoid NaN scores
  return [...activation.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxNeighbors)
    .map(([id, act]) => {
      const record = recordById.get(id)!;
      const label = "linked via entity graph";
      const score = roundScore(0.02 * (act / maxAct)); // small supplementary band
      return { record, score, reasons: [{ kind: "entity" as const, label, score }], explanation: label };
    });
}

function recordTokens(record: MemoryRecord): Set<string> {
  const raw = `${record.normalized} ${record.entities.join(" ")}`.toLowerCase();
  return new Set(
    raw
      .split(/[^a-z0-9_.\/-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1 && !stopWords.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}


function defaultRecordFormatter(item: RankedMemoryRecord): string {
  return `- [${item.record.type}] ${item.record.content}\n`;
}

function queryTerms(query: string | undefined): string[] {
  return unique(
    (query ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_.\/-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1 && !stopWords.has(term))
  );
}

function queryFileTerms(query: string | undefined): string[] {
  return queryTerms(query).filter(isFileLike);
}

function searchableText(record: MemoryRecord): string {
  return `${record.type} ${record.content} ${record.normalized} ${record.entities.join(" ")}`.toLowerCase();
}

function recencyScore(record: MemoryRecord, nowMs: number): number {
  const updatedMs = timestamp(record.updatedAt || record.createdAt);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) return 0;
  const ageDays = Math.max(0, (nowMs - updatedMs) / 86_400_000);
  return roundScore(1 / (1 + ageDays / 30));
}

function timestamp(value: Date | string | number): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isFileLike(value: string): boolean {
  return /[/.\\]/.test(value) || /\.[a-z0-9]+$/i.test(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
