import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs helper, no type declarations
import { sha256, fileHash, brainFingerprint, readLedger, findBaseline, appendRow, metricDelta } from "../scripts/lib/eval-ledger.mjs";

describe("eval-ledger", () => {
  it("hashes deterministically and detects content change", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });

  it("fingerprints a brain by record count + content hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "peon-ledger-"));
    const mem = join(dir, ".peon", "brain", "memories.jsonl");
    appendRow(mem, { id: "a" }); // reuse mkdir+append
    appendRow(mem, { id: "b" });
    const fp = brainFingerprint(dir);
    expect(fp.records).toBe(2);
    expect(fp.hash).toMatch(/^[0-9a-f]{16}$/);
    // absent brain → sentinel, never throws
    expect(brainFingerprint(join(dir, "nope")).hash).toBe("absent");
  });

  it("append + read round-trips JSONL rows", () => {
    const p = join(mkdtempSync(join(tmpdir(), "peon-ledger-")), "eval-results", "history.jsonl");
    appendRow(p, { kind: "x", n: 1 });
    appendRow(p, { kind: "x", n: 2 });
    const rows = readLedger(p);
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
    expect(readLedger(join(p, "does-not-exist"))).toEqual([]);
  });

  it("findBaseline prefers an EXACT same-brain match (trustworthy A/B)", () => {
    const rows = [
      { kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "b1" }, metrics: { r: 0.1 } },
      { kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "b2" }, metrics: { r: 0.2 } }, // newer, different brain
      { kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "b1" }, metrics: { r: 0.3 } }  // newest, SAME brain as target
    ];
    const target = { kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "b1" } };
    const base = findBaseline(rows, target);
    expect(base.sameBrain).toBe(true);
    expect(base.row.metrics.r).toBe(0.3);
  });

  it("findBaseline falls back to a brain-drifted row (informational) and flags it", () => {
    const rows = [{ kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "OLD" }, metrics: { r: 0.5 } }];
    const base = findBaseline(rows, { kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "NEW" } });
    expect(base.sameBrain).toBe(false);
    expect(base.row.metrics.r).toBe(0.5);
  });

  it("findBaseline returns null when kind or qrels differ (never a false comparison)", () => {
    const rows = [{ kind: "labeled-retrieval", qrelsHash: "q1", brain: { hash: "b1" } }];
    expect(findBaseline(rows, { kind: "labeled-retrieval", qrelsHash: "DIFFERENT", brain: { hash: "b1" } })).toBeNull();
    expect(findBaseline(rows, { kind: "OTHER", qrelsHash: "q1", brain: { hash: "b1" } })).toBeNull();
  });

  it("metricDelta computes signed deltas only for shared numeric keys", () => {
    expect(metricDelta({ a: 0.5, b: 0.3, c: "x" }, { a: 0.4, b: 0.3 })).toEqual({ a: expect.closeTo(0.1, 5), b: 0 });
    expect(metricDelta({ a: 1 }, null)).toEqual({});
  });

  it("fileHash returns a sentinel for a missing file instead of throwing", () => {
    expect(fileHash("/no/such/qrels.json")).toBe("absent");
    const f = join(mkdtempSync(join(tmpdir(), "peon-ledger-")), "q.json");
    writeFileSync(f, '{"x":1}');
    expect(fileHash(f)).toBe(sha256(readFileSync(f, "utf8")));
  });
});
