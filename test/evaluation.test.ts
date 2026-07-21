import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { computeEvaluationReport, evaluatePeonProject } from "../src/evaluation.js";

describe("Peon evaluation", () => {
  test("computes deterministic recall, coverage, missing memories, noisy items, and cost", () => {
    const report = computeEvaluationReport({
      expectedMemories: [
        "Use gated AI processing for Peon memory.",
        "Keep API calls low-cost.",
        "Ship the installer as a dry-run helper."
      ],
      retrievedText: [
        "- Use gated AI processing for Peon memory.",
        "- unrelated coffee preference"
      ],
      injectedText: "Preferences\n- Keep API calls low-cost.",
      processingJobs: [
        { status: "processed", model: "test-model", estimatedTokens: 120 },
        { status: "skipped", reason: "below_threshold", estimatedTokens: 30 },
        { status: "failed", model: "test-model", estimatedTokens: 50 }
      ]
    });

    expect(report).toEqual({
      expectedCount: 3,
      observedItemCount: 3,
      matchedExpectedCount: 2,
      matchedObservedItemCount: 2,
      recall: 0.6667,
      coverage: 0.6667,
      missingExpectedItems: [
        {
          id: "expected-3",
          content: "Ship the installer as a dry-run helper."
        }
      ],
      unexpectedNoisyItems: [
        {
          source: "retrieved",
          content: "unrelated coffee preference"
        }
      ],
      matches: [
        {
          expectedId: "expected-1",
          expectedContent: "Use gated AI processing for Peon memory.",
          observedSource: "retrieved",
          observedContent: "Use gated AI processing for Peon memory.",
          score: 1
        },
        {
          expectedId: "expected-2",
          expectedContent: "Keep API calls low-cost.",
          observedSource: "injected",
          observedContent: "Keep API calls low-cost.",
          score: 1
        }
      ],
      costSummary: {
        jobCount: 3,
        processedJobs: 1,
        skippedJobs: 1,
        failedJobs: 1,
        totalEstimatedTokens: 200,
        byModel: {
          "test-model": {
            jobCount: 2,
            estimatedTokens: 170
          },
          unknown: {
            jobCount: 1,
            estimatedTokens: 30
          }
        }
      }
    });
  });

  test("reads expected memories, brain files, records, injection preview, and processing state from a project", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "peon-evaluation-test-"));
    const peonPath = join(projectPath, ".peon");
    await mkdir(join(peonPath, "brain"), { recursive: true });
    await mkdir(join(peonPath, "evaluation"), { recursive: true });
    await writeFile(
      join(peonPath, "evaluation", "expected-memories.json"),
      JSON.stringify(["Remember the dashboard route.", "Persist processing state."], null, 2),
      "utf8"
    );
    await writeFile(join(peonPath, "brain", "decisions.md"), "# Decisions\n- Remember the dashboard route.\n", "utf8");
    await writeFile(
      join(peonPath, "brain", "memories.jsonl"),
      `${JSON.stringify({ content: "Extra unrelated note." })}\n`,
      "utf8"
    );
    await writeFile(join(peonPath, "brain", "injection-preview.md"), "Persist processing state.", "utf8");
    await writeFile(
      join(peonPath, "brain", "processing-state.json"),
      JSON.stringify({ lastStatus: "processed", lastModel: "test-model", lastEstimatedTokens: 77 }, null, 2),
      "utf8"
    );

    const report = await evaluatePeonProject({ projectPath });

    expect(report.expectedCount).toBe(2);
    expect(report.recall).toBe(1);
    expect(report.coverage).toBe(0.6667);
    expect(report.unexpectedNoisyItems).toEqual([{ source: "retrieved", content: "Extra unrelated note." }]);
    expect(report.costSummary).toMatchObject({
      jobCount: 1,
      processedJobs: 1,
      totalEstimatedTokens: 77,
      byModel: {
        "test-model": {
          jobCount: 1,
          estimatedTokens: 77
        }
      }
    });
  });
});
