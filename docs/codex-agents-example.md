# Codex: teaching the agent to use Peon

Codex has no hook system, so it will not call Peon on its own. Add rules to
`~/.codex/AGENTS.md` (or your project's `AGENTS.md`) so the agent knows the memory exists
and uses it. Copy this block:

```markdown
## Peon memory layer

The Peon MCP server is your persistent memory. Use it every session.

At the start of a meaningful session:
- Call `start_session` with the current project path and client `codex`.
- Call `get_context` for the current project before relying on past decisions,
  and pass the user's question as the `query`.

During the session:
- Record important user instructions, decisions, preferences, and open questions
  with `record_message`.
- Search first: before re-reading code or re-running work to answer "how did we
  do X" or "what did we decide about Y", call `search_memory`. The answer is
  often already there.

Before ending meaningful work:
- Call `end_session` if a session was started.
```

Two notes from real usage:

- The `projectPath` you pass is canonicalized by the daemon, so a subfolder resolves to the
  project's brain. Pass `cwd` and let Peon figure it out.
- `record_message` is for durable facts, not chat noise. A good filter: would this matter in
  two weeks? Decisions, rules, results, and file locations qualify. "Ran the tests again" does
  not.
