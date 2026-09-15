import path from 'node:path';
import type { AgentEvalOptions } from '../../../types.ts';
import { expect } from 'vitest';
import fs from 'node:fs';
import { createAgentEval } from '../../../index.ts';

const agentEval = createAgentEval({
  artifactsDir: process.env.EVAL_TEST_ARTIFACTS!,
  runner: async () => {
    fs.appendFileSync(path.join(process.env.EVAL_TEST_DIRECTORY!, 'runs'), 'run\n');
    return { finalAnswer: 'refreshed', toolCalls: [], endReason: 'completed', artifacts: [] };
  },
});

const options: AgentEvalOptions<{ reloads: number }> = {
  prompt: 'refresh',
  projectSetup: {
    prepareAsync({ root, onCleanup }) {
      fs.writeFileSync(path.join(process.env.EVAL_TEST_DIRECTORY!, 'workspace'), root);
      onCleanup(() =>
        fs.writeFileSync(path.join(process.env.EVAL_TEST_DIRECTORY!, 'cleanup'), 'done')
      );
      return { reloads: 1 };
    },
  },
};

agentEval(import.meta.url, options, (check) => {
  check('first fails', () => expect(1).toBe(2));

  check('second still executes', (_ws, { fixture, execution }) => {
    expect(fixture.reloads).toBe(1);
    expect(execution.finalAnswer).toBe('refreshed');
  });

  check('not applicable', (_ws, { skip }) => skip('no native runtime'));
});

agentEval.skip(import.meta.url, { ...options, title: 'skipped case' }, (check) => {
  check('never executes', () => {
    throw Error('must skip');
  });
});
