# Changelog

## 1.0.8

### Fixed — the daemon no longer wedges on large brains

- **Quadratic conflict scan.** `detectMemoryConflicts` compared every pair of records,
  rebuilding an entity map, re-normalizing both contents and constructing up to 16
  RegExps per pair. On a 30.8k-record brain that is 280,762,056 pairs; a CPU profile
  of the live daemon put 93% of all time there and requests stopped answering.
  Candidates are now indexed by shared entity and per-record data is computed once.
  Measured on the real brain: 12,567ms -> 2,314ms with identical results (112/112
  conflicts), or 379ms with a tighter bucket cap. `PEON_CONFLICT_MAX_ENTITY_BUCKET`.
- **Unbounded caches.** The embedding sidecar cache pinned every project's vectors
  forever (a heap snapshot showed 338 MB across 8 stores), and the open-store map never
  released a project. Both are now LRU-bounded with a TTL and an idle sweeper.
  `PEON_EMBED_CACHE_STORES`, `PEON_EMBED_CACHE_TTL_MS`, `PEON_MAX_OPEN_STORES`.
- **Logger read the whole log on every poll.** `recent()` slurped a 106 MB file and
  split it to keep 100 lines. It now reads a bounded tail, and the log rotates.
- **Quadratic duplicate scan.** `detectDuplicates` is now indexed on rare tokens:
  6x fewer comparisons on the real brain, identical results.
- **Quadratic semantic dedup.** Bucketed candidate search with a per-record cap, and
  cooperative yielding so a long pass cannot starve the event loop.

### Fixed — local-only mode actually works

- Six modules hardcoded the OpenRouter URL and gated on `openRouterApiKey`, so with
  `PEON_PROVIDER=ollama` and no key, entity extraction, HyDE, reranking, compression,
  recuration and global extraction silently did nothing. They now route through
  `llmEnabled` / `llmEndpoint` / `llmHeaders`.
- Consolidation requests `response_format: json_object`. Local 7B models otherwise
  reply conversationally and every consolidation is lost to a parse error.
- Automatic consolidation (session end, turn end, heartbeat, `maybe_process_memory`)
  still gated on `openRouterApiKey`, so a fully-local setup skipped every run as
  `missing_api_key`, even when forced, and the raw log grew unconsolidated. The gate
  now uses `llmEnabled`. A hosted provider with no key is still skipped.

### Fixed — a too-small model context window no longer eats sessions silently

- Ollama's default context is 4,096 tokens. A consolidation prompt is ~18k, and
  Ollama does not error on overflow: it keeps the tail and drops the head, which is
  the system prompt and the JSON schema. The model then returned `{}`, Peon applied
  nothing, and still advanced the cursor, so the session was marked consolidated
  with no memories extracted.
- Consolidation now compares the server's reported `usage.prompt_tokens` with its
  own estimate and refuses a result when under half the prompt was read. The cursor
  is not moved, so the session is retried once the window is fixed, and the error
  says how: a model with `PARAMETER num_ctx 32768`, or `OLLAMA_CONTEXT_LENGTH`.
  Verified against Ollama: `qwen2.5:7b` (4k) reported 4,096 of ~18,384 tokens and was
  refused; the same input on a 32k-context build was accepted.
- The size estimate behind that check is script-aware. chars/4 undercounts CJK, so a
  truncated Chinese/Japanese/Korean prompt looked whole: a 12k-character CJK log capped
  at 4,096 read as 4,096 of ~4,500 and was accepted. Han, kana and hangul now count
  0.75 tokens per character and other non-ASCII 0.35; ASCII stays at chars/4, so
  English is unchanged (+0.07% on a real log). The weights stay under 2x the most
  efficient known tokenizer rates, so untruncated CJK (0.45 tokens/char) and Cyrillic
  (0.22) prompts on hosted models are not refused.

### Security

- **Cross-site browser requests are refused.** The daemon already rejected non-loopback
  `Host` (DNS rebinding) and cross-origin `Origin`/`Referer`, which covers POSTs. But an
  `<img>` or no-referrer fetch from another site sends neither header, and
  `GET /context?projectPath=...` opens a store, which creates a `.peon/` brain at that path.
  Any web page could plant brains in any directory the user can write. Browsers label those
  requests `Sec-Fetch-Site: cross-site`, and the guard now refuses them. The hook, the MCP
  server and curl send no such header; the monitor's own requests are `same-origin`.
- **Dependency floors raised to patched versions:** `@modelcontextprotocol/sdk` `^1.29.0`
  (GHSA-345p-7cg4-v4c7, GHSA-8r9q-7v3j-jr4g, GHSA-w48q-cv73-mx4w) and `vitest` `^4.1.11`
  (GHSA-5xrq-8626-4rwp, GHSA-82fw-gwwq-j7x9). The lockfile already resolved to these, so
  `npm audit` was clean; the old floors still admitted vulnerable versions. Peon's MCP server
  uses the stdio transport, so the SDK's HTTP-transport advisories never applied, and vitest
  is a dev dependency that is not installed for users.

## 1.0.7

### Fixed

- **Degraded embedding fallbacks no longer poison the vector sidecar.**
  `FallbackEmbeddingClient` reported the *primary* model's name even after falling
  back to local trigram vectors, so a brief embedding-server blip persisted 256-dim
  vectors under (for example) `qwen3-embedding:0.6b`. Every later sync saw a matching
  model + hash and "reused" them forever. Nothing errored — but `cosineSimilarity`
  returns 0 on a length mismatch, so those beliefs silently disappeared from semantic
  recall. Observed on a real brain after an Ollama restart: 30,834 of 31,966 vectors
  affected.

  `sync()` now refuses to persist vectors from a degraded run (they are still returned,
  so retrieval degrades gracefully for that call), and treats vector width as part of
  validity — so sidecars poisoned before this release repair themselves on the next
  sync. The client's real width is cached per model and probed only when nothing else
  needs recomputing, so there is no extra round trip in the common path.

  Affects any setup where the embedding server can become briefly unreachable: Ollama,
  LM Studio, or a hosted endpoint mid-outage.

- **Embedding downgrades are now loud.** Peon falls back to deterministic local
  trigram embeddings when the configured embedder is unavailable — correct, but it
  was silent, which is indistinguishable from working while semantic recall
  collapses. `resolveEmbeddingPlan()` reports intended vs effective mode and why they
  differ, and `createEmbeddingClient()` warns once per reason. `onFallback` existed
  but no caller ever passed it, so runtime degrades were invisible too; there is now
  a default that warns once per process.

- **All dependency advisories resolved** (1 high, 4 moderate). Three were in the
  production tree via `@modelcontextprotocol/sdk` — `fast-uri` (high), `hono`, `qs` —
  so they reached everyone installing peon-mem. Lockfile-only; `package.json`
  unchanged.


All notable changes to `peon-mem`. Dates are release dates.

## 1.0.6

### Performance — a loaded brain costs 40% less memory and loads 3.2x faster

`decodeVector` ended in `Array.from(new Float32Array(...))`, converting a compact typed array
into a JS `number[]` where every dimension is stored as a double. That doubled the bytes and
copied every vector on each cold load. Decoded vectors now stay `Float32Array`.

Measured on a real 27,232-vector brain, same `vectorById()` path:

| | memory | load |
|---|---|---|
| before (`number[]`) | 648 MB | 941 ms |
| after (`Float32Array`) | **389 MB** | **296 ms** |

`EmbeddingVector` widens to `number[] | Float32Array` — providers still return plain arrays, the
sidecar now yields typed ones, and consumers only index and read `.length`. The decode slices the
buffer so each vector owns its bytes rather than pinning Node's shared Buffer pool.

A single-slab-plus-subarray-views layout was also measured and **not** adopted: 171 MB against
163 MB for plain per-vector typed arrays, because the preallocated slab wastes space on skipped
rows and the views add their own overhead.

Of the remaining 389 MB, roughly 163 MB is vectors; the rest is the 27k `StoredEmbedding` objects
and the maps around them. That is where to look if this ever needs to go lower.

## 1.0.5

### Added

- **Cline is detected by the installer** ([#5](https://github.com/VineetV2/peon-mem/pull/5), thanks
  [@adity982](https://github.com/adity982) — Peon's first external contribution). The wizard targets
  Cline's VS Code extension settings first, platform-aware, and falls back to the `~/.cline` CLI
  path. Twelve apps detected now.
- **A star and feedback prompt at the two moments people are receptive**: the end of a successful
  install, and a quiet link in the monitor header. Deliberately not in the daemon or the hooks —
  those run constantly and any prompt there becomes noise.

### Fixed

- **The monitor no longer claims "No projects yet" while it is still loading.** The projects route
  called its async loader without awaiting it, so the grid painted its empty state with no data.
  On a large brain `/network` takes seconds, so a definite and wrong answer sat on screen for the
  whole wait — and a silent `catch` left it there permanently if the request failed, with the
  throttle blocking a retry. The three heavy endpoints now track load state, distinguish
  "Reading project brains…" from "No projects yet", offer a retry on failure, treat a non-2xx as
  an error rather than parsing an error body as data, and keep showing cached data when a refresh
  fails instead of blanking.

### Changed

- The LongMemEval figure (61% vs 17%) is now labelled **self-measured** wherever it appears, and
  points at `npm run eval`. It is one person's measurement of their own tool, and it was worded
  like an established benchmark result. Raised by a maintainer reviewing Peon for integration.

## 1.0.4

### Added — readable search results in the monitor

Search made stars flare and showed a match count, but you could not read what memory actually
said without clicking stars one at a time. The Neural Universe now answers a query:

- **An extractive summary** — the strongest matching belief in prose, plus how many more there
  are, which projects they live in, and when memory last changed on the topic. No model call, so
  it works with `PEON_AI_MODE=off`.
- **Type and entity facets** — "4 summaries · 3 decisions · 3 facts", and the entities involved.
- **Readable ranked hits** — each showing project, recall count, age, and status. Click one to
  inspect it and fly the camera to that star.
- **Provenance in the detail panel** — when a belief was learned and last updated, how many times
  it has been recalled and when, whether it is pinned or was folded into a summary, and the
  source that produced it.

Ranking fixes found while testing on a 37k-belief brain: hits dedupe by record id (a belief drawn
in two galaxies was counted and listed twice), active beliefs outrank superseded ones (the same
reasoning as stale-shadow demotion), and a summary strips a leading file path so it reads as an
answer rather than a filename.

### Security

`npm audit` reported 6 advisories — 4 in production, all transitive through
`@modelcontextprotocol/sdk` (the only direct runtime dependency): `fast-uri` host confusion
(high), `ip-address` SSRF/trust-boundary bypass (high), `hono` CORS ReDoS (moderate), and
`@hono/node-server` path traversal on Windows (moderate). Peon's own exposure was limited — the
MCP server runs over stdio rather than the SDK's HTTP stack, and the daemon is loopback-only with
DNS-rebinding protection — but the tree should not fail `npm audit`. Bumped to SDK 1.29;
**0 vulnerabilities** now reported.

## 1.0.3

### Fixed — false-positive memory conflicts (root cause)

Beliefs were being wrongly flagged as contradicting each other, then benched out of recall
and left there for weeks because nothing could resolve them. Three fixes remove the cause:

- **Entity stopword filter.** A bare lowercase token like `not`, `use`, or `no` fell through
  `canonicalizeEntity` and became a domain entity. Unrelated beliefs then "shared an entity"
  and got false-flagged. These words are now rejected as entities.
- **Same-topic gate on conflict detection.** A shared entity plus one opposing word-pair
  (e.g. `use`/`avoid`, `enabled`/`disabled`) anywhere in two long beliefs was too weak — on a
  research brain, dozens of beliefs mention the same benchmark. Conflict detection now requires
  a real same-subject signal (two or more shared entities, or content-token Jaccard ≥ 0.25)
  before flagging.
- **Orphan reactivation.** A belief flagged `conflicted` that no longer collides with anything
  (including semantic conflicts the deterministic detector can't re-detect) was left benched
  forever. The sleep cycle now promotes these back to active, so the backlog self-heals.

10 new tests. Nothing is ever hard-deleted — reactivation and archival stay reversible.

## 1.0.2

- Linux install writes a real `systemd` user unit and enables it (was macOS `launchd` only).
- First-class no-AI mode documented (`PEON_AI_MODE=off` + `PEON_EMBEDDING_MODE=off`): deterministic
  capture, lexical retrieval, no model calls.
- Codex integration example added (`docs/codex-agents-example.md`).
- Published to the Official MCP Registry (`io.github.VineetV2/peon-mem`), auto-republish on release.

## 1.0.1

- **Stale-shadow demotion** at retrieval: an older near-duplicate of a newer belief is ranked
  below it instead of shadowing the current truth. Nothing deleted.
- Token-tracking hook logs usage before consolidation, so slow consolidation can't drop the row.
- Measured token A/B results and honest caveats added to the README.

## 1.0.0

- Initial public release. Local-first hierarchical memory (global + per-project brains),
  automatic capture via Claude Code hooks, belief consolidation, episodic verbatim layer,
  hybrid retrieval, the Neural Universe monitor, eval ledger, one-line installer + wizard.
