export interface StartPeonDaemonOptions {
    host?: string;
    port?: number;
    logDir?: string;
    globalMemoryDir?: string;
}
export interface PeonDaemonHandle {
    host: string;
    port: number;
    url: string;
    close(): Promise<void>;
}
/**
 * Resolve any path to its ONE project brain: collapse git-worktree paths to the repo root, then
 * climb ancestors (bounded by home). A `.peon/root` marker declares a brain BOUNDARY — the nearest
 * one wins and the climb stops there, so a big sub-project (e.g. a thesis folder) keeps its OWN
 * brain instead of being swallowed by the parent. With no marker anywhere the behaviour is
 * unchanged: climb to the TOPMOST `.peon` (unify stray subfolders onto the root brain). Applied at
 * the daemon boundary so EVERY caller (Claude hook, direct MCP, Codex) resolves a path identically
 * — not just the hook. Mirrors resolveProjectPath() in scripts/claude-peon-hook.mjs.
 */
export declare function canonicalProjectPath(projectPath: string, home?: string): string;
export declare function startPeonDaemon(options?: StartPeonDaemonOptions): Promise<PeonDaemonHandle>;
