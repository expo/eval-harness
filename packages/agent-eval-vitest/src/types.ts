export type Condition = 'with-skill' | 'without-skill';
export type Cleanup = () => void | Promise<void>;
export type EndReason = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'budget-exhausted';
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  error?: string;
}
export interface AgentExecution {
  finalAnswer: string | null;
  /** null means the runner cannot provide tool evidence. */
  toolCalls: ToolCall[] | null;
  endReason: EndReason;
  /** Paths relative to artifactsDir. */
  artifacts: string[];
  metadata?: Record<string, unknown>;
}
export interface RunnerContext {
  prompt: string;
  root: string;
  artifactsDir: string;
  signal: AbortSignal;
}
/** Reject for infrastructure errors; return evidence for unsuccessful attempts.
 * Runners must stop their resources and settle when signal is aborted. */
export type AgentRunner = (context: RunnerContext) => Promise<AgentExecution>;
export interface PrepareContext {
  root: string;
  condition: Condition;
  signal: AbortSignal;
  artifactsDir: string;
  /** Runs after the case signal is aborted. Use runAsync for bounded cleanup commands. */
  onCleanup(cleanup: Cleanup): void;
  /** Command timeout is in milliseconds; default 600_000. */
  runAsync(command: string, args: string[], options?: { timeoutMs?: number }): Promise<void>;
}
export interface ProjectSetup<T = void> {
  prepareAsync(context: PrepareContext): T | Promise<T>;
}
export interface EvalWorkspace {
  root: string;
  condition: Condition;
  read(relativePath: string): string;
  exists(relativePath: string): boolean;
  sourceFiles(): { path: string; contents: string }[];
  source(): string;
  packageJson(): Record<string, unknown> | undefined;
  glob(pattern: string): string[];
}
export interface AgentEvalOptions<T = void> {
  title?: string;
  prompt: string;
  projectSetup: ProjectSetup<T>;
}
export interface AgentEvalConfig {
  runner?: AgentRunner;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  artifactsDir?: string;
  condition?: Condition;
  dryRun?: boolean;
  keepWorkspace?: boolean;
}
export interface CheckContext<T> {
  fixture: T;
  execution: AgentExecution;
  skip(note?: string): never;
}
export type CheckFn<T> = (
  workspace: EvalWorkspace,
  context: CheckContext<T>
) => void | Promise<void>;
export type DefineChecks<T> = (check: (name: string, fn: CheckFn<T>) => void) => void;
