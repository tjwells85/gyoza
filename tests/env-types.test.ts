import { expect, test } from 'bun:test';
import { join } from 'node:path';

// tests/env-types augments Bun.Env globally, so it can't share the root program
// with preflight.types.ts (which covers the untyped fallback). Its assertions are
// expect-error directives, and an unused one is itself an error.
test('ctx.serverEnv is keyed by the project Bun.Env augmentation', () => {
  const tsc = Bun.spawnSync(['bunx', 'tsc', '--noEmit', '-p', join(import.meta.dir, 'env-types')], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe('');
  expect(tsc.exitCode).toBe(0);
}, 60_000);
