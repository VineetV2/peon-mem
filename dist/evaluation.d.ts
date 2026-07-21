export type EvaluationTextInput = string | string[];
export interface ExpectedMemoryInput {
    id?: string;
    content: string;
}
export interface ProcessingJobInput {
    status?: "processed" | "skipped" | "failed" | string;
    model?: string;
    reason?: string;
    estimatedTokens?: number;
}
export interface EvaluationInput {
    expectedMemories: Array<string | ExpectedMemoryInput>;
    retrievedText?: EvaluationTextInput;
    injectedText?: EvaluationTextInput;
    processingJobs?: ProcessingJobInput[];
}
export interface EvaluationReport {
    expectedCount: number;
    observedItemCount: number;
    matchedExpectedCount: number;
    matchedObservedItemCount: number;
    recall: number;
    coverage: number;
    missingExpectedItems: Array<{
        id: string;
        content: string;
    }>;
    unexpectedNoisyItems: Array<{
        source: "retrieved" | "injected";
        content: string;
    }>;
    matches: Array<{
        expectedId: string;
        expectedContent: string;
        observedSource: "retrieved" | "injected";
        observedContent: string;
        score: number;
    }>;
    costSummary: {
        jobCount: number;
        processedJobs: number;
        skippedJobs: number;
        failedJobs: number;
        totalEstimatedTokens: number;
        byModel: Record<string, {
            jobCount: number;
            estimatedTokens: number;
        }>;
    };
}
export interface EvaluatePeonProjectInput {
    projectPath: string;
    memoryDirName?: string;
    expectedMemories?: Array<string | ExpectedMemoryInput>;
}
export declare function computeEvaluationReport(input: EvaluationInput): EvaluationReport;
export declare function evaluatePeonProject(input: EvaluatePeonProjectInput): Promise<EvaluationReport>;
