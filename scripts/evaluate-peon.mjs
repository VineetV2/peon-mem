#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const projectPath = resolve(process.argv[2] || process.cwd());
const expectedPath = readOption("--expected");
const memoryDirName = readOption("--memory-dir") || ".peon";
const evaluationModulePath = resolve(packageDir, "dist", "evaluation.js");

if (!(await exists(evaluationModulePath))) {
  console.error(
    JSON.stringify(
      {
        error: "Peon evaluation module is not built.",
        expectedModule: evaluationModulePath,
        buildCommand: "npm --workspace @peon/mcp run build"
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} else {
  const { evaluatePeonProject } = await import(pathToFileURL(evaluationModulePath).href);
  const expectedMemories = expectedPath ? JSON.parse(await readFile(resolve(expectedPath), "utf8")) : undefined;
  const report = await evaluatePeonProject({
    projectPath,
    memoryDirName,
    expectedMemories
  });
  console.log(JSON.stringify(report, null, 2));
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function exists(path) {
  return access(path).then(
    () => true,
    () => false
  );
}
