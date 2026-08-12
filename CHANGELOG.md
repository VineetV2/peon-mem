# Changelog

All notable changes to `peon-mem`. Dates are release dates.

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
