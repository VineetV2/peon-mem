# 🧠 Peon — a memory brain for your AI coding agents

**Local-first, hierarchical, self-improving memory for Claude Code, Codex, and any MCP client.**

Your AI forgets everything between sessions. Peon doesn't. It records your sessions, consolidates
them into typed *beliefs* with an LLM, and injects the relevant ones back into every prompt —
automatically, from a daemon that never leaves your machine.

```
        PEON GLOBAL BRAIN            ← user-level facts & preferences, inherited everywhere
       /        |         \
  project A  project B  project C    ← rooted child brains (.peon/ in each project)
```

## Why Peon

- **Hierarchical brains** — one global parent brain (who you are, your rules, your tools) plus an
  isolated child brain per project. Every injection = project memory + inherited global memory.
- **Two memory layers, honestly measured** — consolidated *beliefs* (decisions, preferences, facts,
  artifacts…) for gist, plus an *episodic* verbatim layer that recovers exact details lossy
  summaries drop (measured on LongMemEval: raw-episodic recall 61% vs belief-only 17%).
- **Auto capture + auto injection** — Claude Code hooks record messages/events and inject a
  query-ranked memory block (with an `⚠ MOST RELEVANT` headline) into every prompt. Zero effort.
- **Cost-gated consolidation** — an LLM distills sessions into beliefs only when enough new
  memory accumulates. Supersede / merge / conflict-detect; nothing is destructively deleted.
- **Hybrid retrieval** — lexical + semantic RRF fusion, MMR diversity, reinforcement, recency;
  query-embedding cache (persisted) so repeat prompts cost nothing.
- **The Neural Universe** — a live monitor at `localhost:3737/monitor` that renders every belief
  as a star: projects are galaxies, search makes matches flare, autonomous curation pulses.
- **A daily self-improvement loop (STL)** — Peon audits itself every day: what it recorded,
  injected, what failed, what consolidation did — and files a report with a verdict.
- **Eval-gated development** — a committed results ledger (git SHA + qrels + brain fingerprint per
  row) so retrieval changes are *proven*, not asserted. Negative results stay documented.
- **Local-first & locked down** — plain JSONL you can read, loopback-only daemon with
  DNS-rebinding protection, secret redaction at the injection boundary, path-traversal guards.

## Quickstart

Requirements: Node 20+, macOS or Linux. An [OpenRouter](https://openrouter.ai) API key is
recommended (consolidation + semantic embeddings); without one Peon still works lexical-only.

```bash
git clone https://github.com/vineetvora/peon && cd peon
npm install
npm run build
node scripts/install-peon.mjs        # prints your exact hook + MCP config snippets
```

Create `.env` in the repo root:

```bash
OPENROUTER_API_KEY=sk-or-...
PEON_PROCESSING_MODEL=google/gemini-2.5-flash-lite   # cheap + good enough (measured)
PEON_EMBEDDING_MODEL=openai/text-embedding-3-small
```

Start the daemon (the installer prints a launchd/systemd recipe, or just):

```bash
node dist/daemon-cli.js              # serves 127.0.0.1:3737
```

Then wire your agent (the installer prints these filled in for your paths):

- **Claude Code** — add the hook to `~/.claude/settings.json` (SessionStart / UserPromptSubmit /
  SessionEnd → `scripts/claude-peon-hook.mjs`) and the MCP server (`dist/index.js`).
- **Codex / any MCP client** — register `dist/index.js` as a stdio MCP server; 16 tools
  (`start_session`, `get_context`, `search_memory`, `record_message`, `process_memory`, …).

Open `http://127.0.0.1:3737/monitor` and watch your brain grow.

## How it works

1. **Record** — hooks stream messages/events/tool-calls into `<project>/.peon/raw/` (append-only).
2. **Consolidate** — past a size gate, an LLM turns the session delta into typed belief records in
   `.peon/brain/memories.jsonl` (importance/confidence scores, entities, provenance pointers),
   reconciling against existing beliefs: supersede, merge, conflict-flag. Recoverable, never deleted.
3. **Retrieve + inject** — on every prompt, beliefs are ranked (RRF lexical+semantic, MMR,
   reinforcement) and injected alongside episodic verbatim matches and inherited global beliefs.
4. **Self-curate** — a background brain pass reinforces recalled beliefs, compresses stale
   clusters, resolves duplicates — every action logged and undoable.
5. **Self-audit (STL)** — a daily job reports: recorded / injected / went-wrong / consolidation
   correctness, with serve-latency telemetry and a health verdict.

## Configuration (env)

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | consolidation + embeddings |
| `PEON_PROCESSING_MODEL` | `google/gemini-2.5-flash-lite` | consolidation model |
| `PEON_EMBEDDING_MODE` | auto | `api` / `ollama` / `local` / `off` |
| `PEON_EMBEDDING_MODEL` | — | e.g. `openai/text-embedding-3-small` or an Ollama model |
| `PEON_OLLAMA_URL` | `http://127.0.0.1:11434` | local embedding server |
| `PEON_AI_MODE` | `gated` | `off` disables all LLM calls |
| `PEON_FLUSH_MIN_CHARS` | `6000` | consolidation cost gate |
| `PEON_MEMORY_DIR` | `.peon` | per-project brain dir name |
| `PEON_DAEMON_URL` | `http://127.0.0.1:3737` | daemon address |
| `PEON_CONSOLIDATION_MAX_DELTA_CHARS` | `60000` | anti truncation-stall chunking |
| `PEON_DISABLED` | — | hard off-switch for A/B testing |

## Project brains

- A brain lives in `<project>/.peon/` — human-readable JSONL + markdown. Commit it or ignore it;
  your choice (`.gitignore` ships ignoring it).
- `.peon/root` marks a brain boundary. New brains are born rooted; a parent directory can never
  swallow a project's memory.
- The global brain lives in `~/Library/Application Support/Peon/global/` (macOS).

## Honesty section

Peon's development is eval-gated and keeps its negative results: an associative entity graph was
built, measured (−2.9% Recall@10), and turned OFF by default. Consolidation is lossy by design —
that's why the episodic layer exists and is regression-tested. The eval harness + committed
ledger (`npm run eval`) let you verify retrieval changes on your own brain.

## Security

- Daemon binds `127.0.0.1` only and rejects non-loopback `Host`/`Origin` (DNS-rebinding defense).
- Secrets (API keys, tokens, JWTs) are redacted at the injection boundary.
- Path-traversal guarded; per-project write locks; atomic tmp+rename writes; automatic backups
  before destructive-adjacent operations. Nothing is hard-deleted.

## License

MIT © Vineet Vora
