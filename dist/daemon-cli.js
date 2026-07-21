#!/usr/bin/env node
import { startPeonDaemon } from "./daemon.js";
const host = process.env.PEON_DAEMON_HOST ?? "127.0.0.1";
const parsedPort = Number.parseInt(process.env.PEON_DAEMON_PORT ?? "3737", 10);
const port = Number.isFinite(parsedPort) ? parsedPort : 3737;
/** True if a healthy Peon daemon already answers on this host:port. */
async function daemonAlreadyHealthy() {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1000);
        const response = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok)
            return false;
        const body = (await response.json());
        return body?.service === "peon-daemon";
    }
    catch {
        return false;
    }
}
// Single-owner: if a healthy daemon is already running (e.g. spawned by the MCP
// client), attach to it instead of fighting over the port and crashing.
if (await daemonAlreadyHealthy()) {
    process.stderr.write(`Peon daemon already running on http://${host}:${port} — attaching.\n`);
    process.exit(0);
}
let daemon;
try {
    daemon = await startPeonDaemon({ host, port });
}
catch (error) {
    // Lost a start race (another daemon bound the port between our health check and
    // listen). If it's now healthy, that's fine — attach. Otherwise surface the error.
    if (isAddrInUse(error) && (await daemonAlreadyHealthy())) {
        process.stderr.write(`Peon daemon already running on http://${host}:${port} — attaching.\n`);
        process.exit(0);
    }
    throw error;
}
process.stderr.write(`Peon daemon listening on ${daemon.url}\n`);
function isAddrInUse(error) {
    return Boolean(error && typeof error === "object" && error.code === "EADDRINUSE");
}
async function shutdown() {
    await daemon.close();
    process.exit(0);
}
process.on("SIGINT", () => {
    void shutdown();
});
process.on("SIGTERM", () => {
    void shutdown();
});
