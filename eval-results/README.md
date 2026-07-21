# eval-results — Peon's committed eval ledger

`history.jsonl` is an append-only record of every eval run, so retrieval/quality changes are
**proven against a baseline, not asserted**. Peon's key findings (graph-is-dead; belief-only
16.7% vs raw 61.1%) came from evals that only printed to the console and left no trace — this
directory fixes that.

Each row pins three fingerprints so a comparison is honest:
- `gitSha` — the code under test
- `qrelsHash` — the exact question/relevance set
- `brain` `{records, hash}` — the memory state (retrieval ranks against the LIVE brain, so a diff
  is only apples-to-apples when the brain hash matches)

## Run

```
npm run eval -- <projectPath> [qrelsFile] [K]      # append a labeled-retrieval row + diff vs baseline
```

The harness prints `Δ vs last run, SAME brain (trustworthy A/B)` when the brain hash matches the
previous row (a real code A/B), or flags `⚠ brain changed, informational only` otherwise. Commit
`history.jsonl` so baselines persist across time and machines. A stable, seeded fixture brain
(so the brain hash stays constant) is the next step to make diffs routinely comparable in CI.
