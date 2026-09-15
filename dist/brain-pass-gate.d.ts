/** Test hook: how long an unchanged brain may go without a pass. */
export declare function setBrainPassIdleWindow(ms: number): void;
/** Test hook: forget completed passes and restore the default window. */
export declare function resetBrainPassGate(): void;
/** True when the brain file is unchanged since the last completed pass, and that pass was recent. */
export declare function isIdleSinceLastPass(file: string): Promise<boolean>;
/** Remember the brain file as it stands after a completed pass. */
export declare function recordCompletedPass(file: string): Promise<void>;
