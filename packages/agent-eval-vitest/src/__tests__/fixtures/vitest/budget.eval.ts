import { createAgentEval } from '../../../index.ts';

const agentEval = createAgentEval({
  artifactsDir: process.env.EVAL_TEST_ARTIFACTS!,
  runner: async () => ({
    finalAnswer: 'out of budget',
    toolCalls: [],
    endReason: 'budget-exhausted',
    artifacts: [],
  }),
});

agentEval(import.meta.url, { prompt: 'budget', projectSetup: { prepareAsync() {} } }, (check) => {
  check('preservation passes', () => {});
});
