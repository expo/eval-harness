import { expect, createAgentEval, loadAstSupport, stripComments } from '@expo/agent-eval-vitest';
import { claudeRunner } from '@expo/agent-eval-vitest/claude';
const agentEval = createAgentEval({
  runner: async () => ({
    finalAnswer: 'done',
    toolCalls: [],
    endReason: 'completed',
    artifacts: [],
  }),
});
agentEval(
  import.meta.url,
  {
    prompt: 'refresh',
    projectSetup: {
      prepareAsync() {
        return { observed: true };
      },
    },
  },
  (check) => {
    check('installed package works', async (_ws, { fixture, execution }) => {
      expect(fixture.observed).toBe(true);
      expect(execution.finalAnswer).toBe('done');
      expect(typeof claudeRunner()).toBe('function');
      const ast = await loadAstSupport();
      const parsed = ast.parse('const n: number = 1');
      const nodeTypes: string[] = [];
      ast.walk(parsed, (node) => nodeTypes.push(node.type));
      expect(nodeTypes).toContain('VariableDeclaration');
      expect(() => ast.parse('const = ;')).toThrow();
      expect(stripComments('const url = "https://expo.dev"; // comment')).toBe(
        'const url = "https://expo.dev"; '
      );
    });
  }
);
