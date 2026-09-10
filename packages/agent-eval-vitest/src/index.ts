import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { claudeRunner } from './claude.ts';
import { openCase, resolveConfig } from './lifecycle.ts';
import type { CheckResult } from './lifecycle.ts';
import type { AgentEvalConfig, AgentEvalOptions, DefineChecks } from './types.ts';

export { expect } from 'vitest';
export { createWorkspace } from './workspace.ts';
export { stripComments } from '@expo/source-scan/strip-comments';
export { loadAstSupport } from './ast.ts';
export type { AstSupport } from './ast.ts';
export type * from './types.ts';

export interface AgentEval {
  <T>(caseUrl: string, options: AgentEvalOptions<T>, defineChecks: DefineChecks<T>): void;
  skip: <T>(caseUrl: string, options: AgentEvalOptions<T>, defineChecks: DefineChecks<T>) => void;
  only: <T>(caseUrl: string, options: AgentEvalOptions<T>, defineChecks: DefineChecks<T>) => void;
}

/** Configure a suite without coupling case files to a provider. */
export function createAgentEval(input: AgentEvalConfig = {}): AgentEval {
  const define =
    (mode: 'run' | 'skip' | 'only') =>
    <T>(caseUrl: string, options: AgentEvalOptions<T>, defineChecks: DefineChecks<T>) => {
      const config = resolveConfig({
        ...input,
        runner: input.runner ?? claudeRunner(),
      });
      const id = path.basename(fileURLToPath(caseUrl)).replace(/\.eval\.tsx?$/, '');
      const name = `${id}${options.title ? ` — ${options.title}` : ''} [${config.condition}]`;
      const suite = { run: describe, skip: describe.skip, only: describe.only }[mode];
      suite(name, () => {
        let run: Awaited<ReturnType<typeof openCase<T>>> | undefined;
        const checks: CheckResult[] = [];
        const registeredNames = new Set<string>();
        beforeAll(
          async () => {
            run = await openCase(id, options, config);
          },
          config.timeoutMs + 2 * config.cleanupTimeoutMs + 5_000
        );
        afterAll(
          async (currentSuite) => {
            if (run) {
              // A beforeEach failure can prevent the callback from running at all.
              // Reconcile with Vitest's completed tasks, including hooks/timeouts.
              const collectCheckResults = (tasks: typeof currentSuite.tasks): CheckResult[] =>
                tasks.flatMap((task) => {
                  if (task.type === 'suite') {
                    return collectCheckResults(task.tasks);
                  }
                  if (!registeredNames.has(task.name)) {
                    return [];
                  }
                  let status: CheckResult['status'] = 'skipped';
                  if (task.result?.state === 'fail') {
                    status = 'failed';
                  } else if (task.result?.state === 'pass') {
                    status = 'passed';
                  }
                  const result: CheckResult = { name: task.name, status };
                  const error =
                    task.result?.errors?.map((error) => error.message).join('; ') ??
                    checks.find((check) => check.name === task.name)?.error;
                  if (error) {
                    result.error = error;
                  }
                  return [result];
                });
              await run.close(collectCheckResults(currentSuite.tasks));
              if (!config.dryRun && run.execution.endReason !== 'completed') {
                throw new Error(
                  `Agent execution ended: ${run.execution.endReason}. Artifacts: ${run.artifactsDir}`
                );
              }
            }
          },
          Math.max(60_000, config.cleanupTimeoutMs + 5_000)
        );
        defineChecks((checkName, fn) => {
          if (registeredNames.has(checkName)) {
            throw new Error(`Duplicate agent check name: ${checkName}`);
          }
          registeredNames.add(checkName);
          test(checkName, { retry: 0, repeats: 0, concurrent: false }, async (context) => {
            if (!run) {
              throw new Error('Agent eval setup did not complete');
            }
            const result: CheckResult = { name: checkName, status: 'passed' };
            checks.push(result);
            // Also capture failures imposed by Vitest (timeout, assertion counts, hooks).
            context.onTestFailed(() => {
              result.status = 'failed';
              result.error ??= 'Vitest marked this check as failed';
            });
            try {
              await fn(run.workspace, {
                fixture: run.fixture,
                execution: run.execution,
                skip(note) {
                  result.status = 'skipped';
                  if (note) {
                    result.error = note;
                  }
                  return context.skip(note);
                },
              });
            } catch (error) {
              if (result.status !== 'skipped') {
                result.status = 'failed';
                result.error = error instanceof Error ? error.message : String(error);
              }
              throw error;
            }
          });
        });
      });
    };
  return Object.assign(define('run'), {
    skip: define('skip'),
    only: define('only'),
  });
}

export const agentEval = createAgentEval();
