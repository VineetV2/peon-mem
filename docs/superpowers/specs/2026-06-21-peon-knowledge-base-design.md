# Peon Knowledge-Base — design spec (finish + harden, entity-first)

Status: Phase 0 implemented. Phases 1–4 designed; open questions below to resolve before each.

## Goal

Turn Peon from a lossy *belief stream* into a *knowledge base that works like a brain*. Three outcomes, weighted equally:
1. **Faithful recall** — ask anything → exact, complete answer incl. specifics, with a link to the source.
2. **Clean organized knowledge** — no bloat/duplication; canonical, connected facts.
3. **Connected/associative recall** — traverse from a topic/entity to everything related.

## Architecture (Approach A — belief + graph spine, three layers)

- **L1 Episodic** — raw turns (`raw/*.jsonl`), verbatim + provenance. First-class retrieval layer (`rankEpisodes`, now on by default). The fidelity floor.
- **L2 Semantic beliefs** — canonical, deduped, human-readable unit (`memories.jsonl`). Single source of truth for injection (retire append-only `.md`).
- **L3 Entity graph** — canonical entity/topic nodes + typed edges, *actually queried*. The associative spine.

## Why "finish + harden", not greenfield rebuild

A 7-role expert panel (cognitive-science, KG, consolidation-LLM, IR, systems, pragmatist, red-team) reviewed the design against the live code. Verdict: unanimous needs-changes. Key findings:
- **Entity resolution is the linchpin and it's broken**: entities come from a regex (`inferEntities`) — no people/papers/concepts; severe alias fragmentation (`daemon.ts` under 7 surface forms); phantom nodes from a tokenization bug (the space in "Project_x 2" → `2/peon-mcp/...`); super-hubs (`memories.jsonl` on 81 records). Spreading activation over this is file-co-occurrence, not knowledge.
- **The graph is dead on the retrieval path** (`getContext` never calls `expandGraph`).
- **Two real bugs were being deferred**: no per-project write lock (lost updates) + the embeddings sidecar re-read/rewritten on every prompt.
- "One canonical node per fact" fights context-dependent truths; content-hash ids dangle links on edit; the weak consolidation model is risky for judgment-heavy merge/obsolete.
- Note: panel claimed "no RRF/MMR" — that was stale; RRF + MMR exist (verified). So ranking is fine; even more already built.
~70% of "the rebuild" already exists → finish + harden, entity-resolution-first, measured.

## Phased plan

### Phase 0 — Safety foundation ✅ IMPLEMENTED
- Per-project async write lock (module-level, keyed by resolved memory dir → serializes across the daemon's *two* store instances). Public `runExclusive()`; processor's apply→merge→persist wrapped as one critical section; standalone mutators (`update/delete/pin/merge/archive/runBrainPass`) locked. Proven by a 2-instance concurrent-write test (no lost update).
- Atomic writes (`tmp` → `rename`) for `memories.jsonl`, `graph.json`, and the embeddings sidecar.
- Embedding hot-path: mtime-keyed cache in `EmbeddingStore.load` (26× on re-parse); `getContext`/`rankRecords` now use read-only `vectorById()` — never sync/rewrite on the prompt path (verified: file untouched on read). Backfill stays on the write path under the lock.
- All 176 tests pass.

### Phase 1 — Entity resolution (deterministic-first) ✅ IMPLEMENTED + MIGRATED
- `entities.ts`: `canonicalizeEntity` (kills `2/` phantom, strips abs/worktree prefixes, src-root-relative or parent/basename key, classifies code|domain), `resolveEntities`, `buildEntityRegistry` (cross-form alias merge: bare basename → unique path key; namespace + salience). Replaced `inferEntities`. 7 tests.
- `buildMemoryGraph` now canonicalizes + alias-merges entity nodes and tags each with `namespace`. `entities.jsonl` persisted (derived, atomic) alongside `graph.json`.
- Migration (1c) run on the live Master Project 700B brain after a dry-run that CAUGHT + fixed an over-merge (distinct `DESIGN.md`/`SKILL.md` were collapsing): 2,594 beliefs intact, distinct entity keys 373→274, 35 phantom/abs keys → 0, 461 records updated. Backup `memories-20260621-entitymig.jsonl`.
- Deferred to a later pass: conservative model top-up for domain entities (people/papers); super-hub edge capping (belongs in Phase 2 traversal damping).

### Phase 2 — Associative retrieval ✅ IMPLEMENTED
- `expandByEntityGraph` rewritten as spreading activation: distance decay (λ), multi-source summation, hub damping (1/log₂(2+degree) + degree cap), domain>code namespace weighting, seed-rank decay. Wired into `getContext` (`expandGraph:true`), appended after direct hits so it never displaces them. Tests for multi-source + hub damping.
- **Domain entity extraction** added to the resolver (`extractDomainEntities`): products/acronyms (MaskSQL, BIRD, NL2SQL, DTS-SQL) + proper-noun sequences (Shantanu Sharma), namespaced `domain`. This was the unlock — the graph was dead because only 17% of beliefs had entities (files/backticks only). Re-migrated the live brain: entity coverage **17%→64%**, linkable entities **65→215**. A domain query now surfaces ~6 associatively-linked beliefs it didn't match directly. Backup `memories-20260621-domainent.jsonl`.
- STILL PENDING: query-driven eval harness (Recall@K/MRR/nDCG) to quantify lift + fix the reranker A/B pool confound. Graph is on by default (low-risk: bounded, appended); eval should confirm/tune.

### Phase 3 — Provenance
- Add `provenance` to `MemoryRecord`: **primary ref = the episodic turn** (always locally resolvable); external (gmail/file/url) as secondary enrichment. Retrieval surfaces it so the agent can fetch ground truth.

### Phase 4 — Integrative canonical update (riskiest, last)
- Durable belief ids decoupled from content-hash (edits don't dangle links). Merge only on high confidence; **preserve the loser as recoverable**, not destroyed. `obsolete` soft-by-default. Feed the model real merge candidates via retrieval (not just top-40-by-importance).

### Cross-cutting
- Measurable acceptance criteria per goal on the `_S` split = the done-condition.

## Open questions to resolve before later phases
1. Entity scope: code symbols/files in the SAME graph as domain concepts, or separate graphs/namespaces?
2. Canonical "one node per fact" vs context-tagged coexisting beliefs; preserve merged-loser as conflicted/recoverable?
3. Provenance primary ref = episodic turn (recommended) vs external first-class?
4. Eval ground truth: hand-label ~50–100 cue→belief queries, or bootstrap from past sessions?
5. Concurrency: single-flight consolidation per project (queue overlaps) acceptable?

## Hard constraints
Local-first; human-readable/observable on disk; recoverable (backups/undo); cost-conscious; consolidation model = `gemini-2.5-flash-lite` (don't assume a strong model — architecture beats model choice); never use the Wulver cluster.
