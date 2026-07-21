#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPeonTools } from "./tools.js";
const tools = createPeonTools({ daemonUrl: process.env.PEON_DAEMON_URL });
const server = new McpServer({
    name: "peon-mcp",
    version: "0.1.0"
});
const projectName = (path) => path.split("/").filter(Boolean).pop() ?? "project";
/**
 * Compact text for the model. The internal tool results carry redundant fields
 * (normalized index text, duplicated record arrays, per-reason breakdowns) that
 * would otherwise flood the calling model's context — a single recall could cost
 * thousands of tokens. These formatters return only what an AI needs to read.
 */
function compactContext(ctx) {
    const sections = [
        ["Summary", ctx.summary],
        ["Memory", ctx.memories],
        ["Decisions", ctx.decisions],
        ["Preferences", ctx.preferences],
        ["Open questions", ctx.openQuestions],
        ["Artifacts", ctx.artifacts],
        ["Timeline", ctx.timeline]
    ];
    const body = sections
        .filter(([, value]) => value && value.trim())
        .map(([label, value]) => `## ${label}\n${value.trim()}`)
        .join("\n\n");
    return body || "No memory recorded for this project yet.";
}
function compactSearch(result) {
    return result.injectionPreview?.trim() || `No memory matched "${result.query}".`;
}
function compactBrain(result) {
    const counts = {};
    for (const record of result.records)
        counts[record.status] = (counts[record.status] ?? 0) + 1;
    const status = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "no records";
    const head = `Peon brain — ${projectName(result.projectPath)} (${status}; ${result.graph.nodes.length} graph nodes)`;
    return `${head}\n\n${result.injectionPreview?.trim() || compactContext(result.context)}`;
}
function compactCrossProject(result) {
    if (result.results.length === 0) {
        return `No relevant beliefs found in other projects for "${result.query}" (searched ${result.projectsSearched.length}).`;
    }
    const lines = result.results.map((hit) => `- [${hit.projectName} · ${hit.record.type}] ${hit.record.content}`);
    return `Recall across projects for "${result.query}" (searched ${result.projectsSearched.length}):\n${lines.join("\n")}`;
}
server.registerTool("start_session", {
    title: "Start Peon Session",
    description: "Start a Peon memory session for a project.",
    inputSchema: {
        projectPath: z.string(),
        client: z.string(),
        cwd: z.string().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.startSession(input), null, 2) }]
}));
server.registerTool("record_message", {
    title: "Record Message",
    description: "Record a user, assistant, or system message into Peon memory.",
    inputSchema: {
        sessionId: z.string(),
        role: z.enum(["user", "assistant", "system"]),
        content: z.string()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.recordMessage(input), null, 2) }]
}));
server.registerTool("record_event", {
    title: "Record Event",
    description: "Record a structured Peon memory event such as a decision or preference.",
    inputSchema: {
        sessionId: z.string(),
        type: z.string(),
        content: z.string()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.recordEvent(input), null, 2) }]
}));
server.registerTool("end_session", {
    title: "End Peon Session",
    description: "End a Peon session and update brain files.",
    inputSchema: { sessionId: z.string() }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.endSession(input), null, 2) }]
}));
server.registerTool("get_context", {
    title: "Get Peon Context",
    description: "Return project brain context from Peon memory.",
    inputSchema: {
        projectPath: z.string(),
        query: z.string().optional(),
        maxChars: z.number().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: compactContext(await tools.getContext(input)) }]
}));
server.registerTool("inspect_brain", {
    title: "Inspect Peon Brain",
    description: "Return a compact summary of a project's brain: record counts by status and the prompt injection preview.",
    inputSchema: {
        projectPath: z.string(),
        query: z.string().optional(),
        maxChars: z.number().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: compactBrain(await tools.inspectBrain(input)) }]
}));
server.registerTool("search_memory", {
    title: "Search Peon Memory",
    description: "Search structured Peon memory; returns a compact ranked list with one-line reasons.",
    inputSchema: {
        projectPath: z.string(),
        query: z.string(),
        limit: z.number().optional(),
        maxChars: z.number().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: compactSearch(await tools.searchMemory(input)) }]
}));
server.registerTool("quality_report", {
    title: "Peon Quality Report",
    description: "Inspect Peon memory quality signals: duplicates, conflicts, stale records, and promotions.",
    inputSchema: {
        projectPath: z.string(),
        staleAfterDays: z.number().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.qualityReport(input), null, 2) }]
}));
server.registerTool("build_injection", {
    title: "Build Peon Context Injection",
    description: "Build a redacted context injection from project and global memory with selection explanations.",
    inputSchema: {
        projectPath: z.string(),
        query: z.string().optional(),
        maxChars: z.number().optional(),
        includeInactive: z.boolean().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.buildInjection(input), null, 2) }]
}));
server.registerTool("query_projects", {
    title: "Recall Across Projects",
    description: "Recall relevant beliefs from OTHER Peon projects on demand. Peon memory is isolated per project by default; call this when the user explicitly asks about another project (e.g. 'what did we decide in project Y about auth?'). Omit projectPath to search every known project; pass it to target one. Set excludeProjectPath to the current project so you only get other projects' beliefs.",
    inputSchema: {
        query: z.string(),
        projectPath: z.string().optional(),
        excludeProjectPath: z.string().optional(),
        limit: z.number().optional()
    }
}, async (input) => ({
    content: [
        {
            type: "text",
            text: compactCrossProject(await tools.crossProjectSearch({
                query: input.query,
                projectPaths: input.projectPath ? [input.projectPath] : undefined,
                excludeProjectPath: input.excludeProjectPath,
                limit: input.limit
            }))
        }
    ]
}));
server.registerTool("remember_global", {
    title: "Remember Global Memory",
    description: "Upsert a global Peon memory record for cross-project reuse.",
    inputSchema: {
        memory: z.object({
            type: z.enum(["summary", "decision", "preference", "open_question", "artifact", "timeline", "fact"]),
            content: z.string(),
            scope: z.enum(["project", "global", "session"]).optional(),
            importance: z.number().optional(),
            confidence: z.number().optional(),
            entities: z.array(z.string()).optional(),
            status: z.enum(["active", "stale", "conflicted"]).optional()
        }),
        source: z
            .object({
            kind: z.enum(["ai_processing", "manual", "hook"]).optional(),
            reason: z.string().optional()
        })
            .optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.rememberGlobal(input), null, 2) }]
}));
server.registerTool("search_global_memory", {
    title: "Search Global Peon Memory",
    description: "Search cross-project global Peon memory.",
    inputSchema: {
        query: z.string().optional(),
        type: z.enum(["summary", "decision", "preference", "open_question", "artifact", "timeline", "fact"]).optional(),
        status: z.enum(["active", "stale", "conflicted"]).optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.searchGlobalMemory(input), null, 2) }]
}));
server.registerTool("import_global_memory", {
    title: "Import Global Peon Memory",
    description: "Import global-scoped memory records from a project brain into the global memory store.",
    inputSchema: {
        projectPath: z.string()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.importGlobalMemory(input), null, 2) }]
}));
server.registerTool("evaluate_project", {
    title: "Evaluate Peon Project Memory",
    description: "Evaluate recall, coverage, noise, and cost for a Peon project memory folder.",
    inputSchema: {
        projectPath: z.string(),
        expectedMemories: z
            .array(z.union([z.string(), z.object({ id: z.string().optional(), content: z.string() })]))
            .optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.evaluateProject(input), null, 2) }]
}));
server.registerTool("process_memory", {
    title: "Process Peon Memory",
    description: "Run gated Peon AI processing for a project and update structured brain files.",
    inputSchema: {
        projectPath: z.string(),
        reason: z.string().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.processMemory(input), null, 2) }]
}));
server.registerTool("maybe_process_memory", {
    title: "Maybe Process Peon Memory",
    description: "Apply Peon's automatic cost-aware processing policy and process only when the gate says to run.",
    inputSchema: {
        projectPath: z.string(),
        trigger: z.string(),
        force: z.boolean().optional()
    }
}, async (input) => ({
    content: [{ type: "text", text: JSON.stringify(await tools.maybeProcessMemory(input), null, 2) }]
}));
await server.connect(new StdioServerTransport());
