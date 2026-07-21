import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalProjectPath } from "../src/daemon.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function makeTree() {
  const home = mkdtempSync(join(tmpdir(), "peon-home-"));
  roots.push(home);
  const brain = (p: string) => { mkdirSync(join(home, p, ".peon"), { recursive: true }); };
  return { home, brain };
}

describe("canonicalProjectPath resolution", () => {
  it("climbs to the TOPMOST .peon when there is no boundary marker (unify subfolders)", () => {
    const { home, brain } = makeTree();
    brain("proj");                        // home/proj/.peon
    mkdirSync(join(home, "proj", "sub", "deep"), { recursive: true });
    expect(canonicalProjectPath(join(home, "proj", "sub", "deep"), home)).toBe(join(home, "proj"));
  });

  it("stops at the NEAREST .peon/root boundary — a sub-project keeps its own brain", () => {
    const { home, brain } = makeTree();
    brain("proj");                        // home/proj/.peon  (parent brain, no marker)
    brain("proj/thesis");                 // home/proj/thesis/.peon
    writeFileSync(join(home, "proj", "thesis", ".peon", "root"), ""); // boundary marker
    mkdirSync(join(home, "proj", "thesis", "experiments"), { recursive: true });
    // inside the thesis → its OWN brain, NOT climbed up to home/proj
    expect(canonicalProjectPath(join(home, "proj", "thesis", "experiments"), home)).toBe(join(home, "proj", "thesis"));
    // a sibling under proj (no marker) still unifies at home/proj
    mkdirSync(join(home, "proj", "other"), { recursive: true });
    expect(canonicalProjectPath(join(home, "proj", "other"), home)).toBe(join(home, "proj"));
  });

  it("collapses a git-worktree path before resolving", () => {
    const { home, brain } = makeTree();
    brain("proj");
    const wt = join(home, "proj", ".claude", "worktrees", "feat-x", "sub");
    expect(canonicalProjectPath(wt, home)).toBe(join(home, "proj"));
  });

  it("returns the base path unchanged when no ancestor has a brain", () => {
    const { home } = makeTree();
    mkdirSync(join(home, "loose"), { recursive: true });
    expect(canonicalProjectPath(join(home, "loose"), home)).toBe(join(home, "loose"));
  });
});
