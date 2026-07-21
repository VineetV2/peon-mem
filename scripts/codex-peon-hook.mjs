#!/usr/bin/env node
process.env.PEON_HOOK_CLIENT ||= "codex";

await import("./claude-peon-hook.mjs");
