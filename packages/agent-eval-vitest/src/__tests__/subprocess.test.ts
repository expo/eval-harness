import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandAsync } from '../subprocess.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const r = mkdtempSync(join(tmpdir(), 'eval-process-'));
  roots.push(r);
  return r;
};
test('runs in root and waits for output/exit', async () => {
  const r = root();
  await runCommandAsync(r, 'node', ['-e', "require('fs').writeFileSync('done','yes')"]);
  expect(readFileSync(join(r, 'done'), 'utf8')).toBe('yes');
});
test('rejects startup and nonzero exit with stderr', async () => {
  await expect(runCommandAsync(root(), '/missing-eval-command', [])).rejects.toThrow();
  await expect(
    runCommandAsync(root(), 'node', ['-e', "console.error('diagnostic');process.exit(7)"])
  ).rejects.toThrow('diagnostic');
});
test('pre-aborted calls do not start and invalid timeouts fail', async () => {
  const r = root();
  await expect(
    runCommandAsync(r, 'node', ['-e', "require('fs').writeFileSync('bad','')"], {
      signal: AbortSignal.abort(),
    })
  ).rejects.toThrow();
  expect(existsSync(join(r, 'bad'))).toBe(false);
  await expect(runCommandAsync(r, 'node', [], { timeoutMs: -1 })).rejects.toThrow();
});
test('timeout and abort stop the process group including descendants', async () => {
  if (process.platform === 'win32') return;
  for (const mode of ['timeout', 'abort']) {
    const r = root();
    const controller = new AbortController();
    const script = `const {spawn}=require('child_process');const fs=require('fs');const c=spawn('node',['-e',"setTimeout(()=>require('fs').writeFileSync('escaped','bad'),800);setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('pid',String(c.pid));setInterval(()=>{},1000);`;
    const pending = runCommandAsync(
      r,
      'node',
      ['-e', script],
      mode === 'timeout' ? { timeoutMs: 300 } : { signal: controller.signal }
    );
    if (mode === 'abort') setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow(mode === 'timeout' ? /timed out/i : /abort/i);
    expect(existsSync(join(r, 'pid'))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(existsSync(join(r, 'escaped'))).toBe(false);
  }
});
test('normal exit cleans up descendants that inherited output pipes', async () => {
  if (process.platform === 'win32') return;
  const r = root();
  await runCommandAsync(
    r,
    'node',
    [
      '-e',
      `const c=require('child_process').spawn('node',['-e',"setTimeout(()=>require('fs').writeFileSync('escaped','bad'),500);setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});c.unref();`,
    ],
    { timeoutMs: 2000 }
  );
  await new Promise((r) => setTimeout(r, 600));
  expect(existsSync(join(r, 'escaped'))).toBe(false);
});
