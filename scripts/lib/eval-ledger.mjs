/**
 * Eval results ledger — a committed, append-only history of every eval run so improvements
 * can be PROVEN (diffed against a fixed baseline) rather than asserted.
 *
 * Peon's most valuable findings (graph-is-dead at -2.9%/-3.8% Recall@10; consolidation
 * belief-only 16.7% vs raw 61.1%) came from evals that only `console.log`'d — there was no
 * baseline to regress against. Each row pins THREE fingerprints so a comparison is trustworthy:
 *   - gitSha    : the code under test
 *   - qrelsHash : the exact question/relevance set
 *   - brain     : {records, hash} of memories.jsonl — because retrieval evals rank against the
 *                 LIVE, mutating brain, a diff is only apples-to-apples when the brain matches.
 * Side-effect-free except appendRow/mkdir, so the pure logic is unit-testable.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

export function gitSha(cwd = process.cwd()) {
  try {
    // execFileSync (no shell) with a fixed argv — no interpolation, no injection surface.
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** sha256 of a file's contents (short), or "absent" if unreadable — for the qrels fingerprint. */
export function fileHash(path) {
  try {
    return sha256(readFileSync(path, "utf8"));
  } catch {
    return "absent";
  }
}

/** Pin the memory state: record count + content hash of memories.jsonl. */
export function brainFingerprint(projectPath, memoryDirName = ".peon") {
  const mem = join(projectPath, memoryDirName, "brain", "memories.jsonl");
  let content = "";
  try {
    content = readFileSync(mem, "utf8");
  } catch {
    return { records: 0, hash: "absent" };
  }
  const records = content.split(/\r?\n/).filter(Boolean).length;
  return { records, hash: sha256(content) };
}

export function ledgerPath(cwd = process.cwd()) {
  return join(cwd, "eval-results", "history.jsonl");
}

export function readLedger(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * The most recent prior row comparable to `row`. Prefers an EXACT match (same kind + qrelsHash +
 * brain hash) → a trustworthy code-only A/B. Falls back to the latest same-kind+qrels row with
 * `sameBrain:false` so the caller can still show a delta but flag it as brain-drifted (informational).
 */
export function findBaseline(rows, row) {
  let loose = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind !== row.kind || r.qrelsHash !== row.qrelsHash) continue;
    if ((r.brain && r.brain.hash) === (row.brain && row.brain.hash)) return { row: r, sameBrain: true };
    if (!loose) loose = r;
  }
  return loose ? { row: loose, sameBrain: false } : null;
}

export function appendRow(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/** Signed per-key delta of two flat numeric metric maps (keys present in both). */
export function metricDelta(current, baseline) {
  const out = {};
  if (!baseline) return out;
  for (const k of Object.keys(current)) {
    if (typeof current[k] === "number" && typeof baseline[k] === "number") out[k] = current[k] - baseline[k];
  }
  return out;
}
