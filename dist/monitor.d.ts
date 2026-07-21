/**
 * Peon Memory Cockpit — a dark, multi-page console for trusting, steering, and
 * proving the value of your AI's memory.
 *
 * Served at GET /monitor as one self-contained HTML document (no build step, no
 * CDN — local-first). Hash-routed pages (#/overview, #/memory, #/network, #/ops):
 *   - Overview: what the AI knows, what it injected last, tokens saved, what needs review
 *   - Memory: the belief list — now editable (pin / edit / delete / merge)
 *   - Network: global memory + the cross-project map
 *   - Ops: consolidation cost, token A/B, live traffic and logs
 * Fed by /monitor/state (poll), /overview, /network, and the /memory/* mutations.
 */
export declare function renderMonitorHtml(): string;
