import { createAgentEval } from '../../../index.ts';
import { beforeEach } from 'vitest';

beforeEach(({ task }) => {
  if (task.name === 'hook fails') {
    throw new Error('inherited hook failure');
  }
});

const agentEval = createAgentEval({
  artifactsDir: process.env.EVAL_TEST_ARTIFACTS!,
  runner: async () => ({
    finalAnswer: 'done',
    toolCalls: [],
    endReason: 'completed',
    artifacts: [],
  }),
});

agentEval(
  import.meta.url,
  { prompt: 'hook-failure', projectSetup: { prepareAsync() {} } },
  (check) => {
    check('passes', () => {});
    check('hook fails', () => {});
  }
);
