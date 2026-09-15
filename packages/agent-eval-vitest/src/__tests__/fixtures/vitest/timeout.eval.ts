import { createAgentEval } from '../../../index.ts';

const agentEval = createAgentEval({
  artifactsDir: process.env.EVAL_TEST_ARTIFACTS!,
  runner: async () => ({
    finalAnswer: 'done',
    toolCalls: [],
    endReason: 'completed',
    artifacts: [],
  }),
});

agentEval(import.meta.url, { prompt: 'timeout', projectSetup: { prepareAsync() {} } }, (check) => {
  check('times out', async () => {
    await new Promise(() => {});
  });
});
