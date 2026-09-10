import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function fixture(root) {
  const authored = join(root, 'authored');
  const app = join(authored, 'author-agent-workspace/run-1');
  const metadata = join(authored, 'author-agent-metadata/run-1');
  mkdirSync(app, { recursive: true });
  mkdirSync(join(metadata, 'telemetry/traces'), { recursive: true });
  const json = (file, value) => writeFileSync(file, JSON.stringify(value));
  json(join(authored, 'manifest.json'), { artifact_type: 'authored-app', run_id: 'run-1', prd: 'dataset/prds/test-app/prd/mvp.txt' });
  json(join(metadata, 'manifest.json'), { prd: 'dataset/prds/test-app/prd/mvp.txt' });
  json(join(app, 'package.json'), { dependencies: { 'expo-router': '*' } });
  mkdirSync(join(app, 'app'));
  writeFileSync(join(app, 'app/_layout.tsx'), "import { Stack } from 'expo-router'; export default () => <Stack />;\n");
  writeFileSync(join(app, 'app/index.tsx'), 'export default () => null;\n');
  json(join(metadata, 'telemetry/traces/claude-code-authoring.json'), { agent: 'claude-code', sessions: [{ turns: [{ steps: [{ tool_calls: [{ name: 'Skill', args: { skill: 'expo:expo-router' } }] }] }] }] });
  const prdSkills = join(root, 'prd-skills.json');
  json(prdSkills, { 'test-app': ['expo-router'] });
  return { authored, prdSkills };
}
export function normalize(value, root) {
  if (typeof value === 'string') return value.split(root).join('<fixture>');
  if (Array.isArray(value)) return value.map(v => normalize(v, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, normalize(v, root)]));
  return value;
}
