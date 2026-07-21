import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function renderTokenAbMonitorHtml(): string {
  return readFileSync(join(__dirname, "..", "scripts", "token-ab-monitor.html"), "utf8");
}
