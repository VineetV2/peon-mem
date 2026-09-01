# Changelog

All notable changes to `peon-mem`. Dates are release dates.

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
