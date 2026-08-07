import { describe, test, expect } from 'bun:test';
import {
  defineConfig,
  isDefinedConfig,
  normalizeSteps,
  stepForm,
  validateBuildConfig,
} from '../src/config.ts';
import type { BuildContext, BuildStep, BuildStepMap, GyozaConfig, StepResults } from '../src/config.ts';

const ctxWith = (results: StepResults): BuildContext => ({
  projectRoot: '/tmp/project',
  buildDir: '/tmp/project/build',
  results,
});

/** Mirrors the run loop in src/commands/build.ts. */
const runPhase = async (
  steps: ReturnType<typeof normalizeSteps>,
  phase: 'pre' | 'post',
  ctx: BuildContext,
): Promise<void> => {
  for (const step of steps) {
    const result = await step.run(ctx);
    if (step.key !== undefined && result !== undefined) ctx.results[phase][step.key] = result;
  }
};

// ---------------------------------------------------------------------------
// stepForm
// ---------------------------------------------------------------------------

describe('stepForm', () => {
  test('absent for undefined and null', () => {
    expect(stepForm(undefined)).toBe('absent');
    expect(stepForm(null)).toBe('absent');
  });

  test('array for arrays, including empty', () => {
    expect(stepForm([])).toBe('array');
    expect(stepForm([{ name: 'a', run: () => {} }])).toBe('array');
  });

  test('object for keyed maps, including empty', () => {
    expect(stepForm({})).toBe('object');
    expect(stepForm({ a: { run: () => {} } })).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// normalizeSteps
// ---------------------------------------------------------------------------

describe('normalizeSteps', () => {
  test('keys object-form steps and defaults name to the key', () => {
    const steps = normalizeSteps({
      rustBuild: { run: () => 1 },
      copy: { name: 'Copy artifacts', run: () => 2 },
    });
    expect(steps.map(s => [s.key, s.name])).toEqual([
      ['rustBuild', 'rustBuild'],
      ['copy', 'Copy artifacts'],
    ]);
  });

  test('array-form steps get no key', () => {
    const steps = normalizeSteps([{ name: 'Legacy', run: () => 1 }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.key).toBeUndefined();
    expect(steps[0]!.name).toBe('Legacy');
  });

  test('preserves object insertion order across several steps', () => {
    const steps = normalizeSteps({
      zebra: { run: () => {} },
      alpha: { run: () => {} },
      middle: { run: () => {} },
      beta: { run: () => {} },
    });
    expect(steps.map(s => s.key)).toEqual(['zebra', 'alpha', 'middle', 'beta']);
  });

  test('legacy steps run after own steps, in order', () => {
    const steps = normalizeSteps({ first: { run: () => {} } }, [
      { name: 'legacyA', run: () => {} },
      { name: 'legacyB', run: () => {} },
    ]);
    expect(steps.map(s => s.name)).toEqual(['first', 'legacyA', 'legacyB']);
  });

  test('handles an absent step collection', () => {
    expect(normalizeSteps(undefined)).toEqual([]);
    expect(normalizeSteps(undefined, [{ name: 'legacy', run: () => {} }])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// validateBuildConfig
// ---------------------------------------------------------------------------

const diagnose = (build: GyozaConfig['build'], branded = false): ReturnType<typeof validateBuildConfig> => {
  const config: GyozaConfig = branded ? defineConfig({}) : {};
  config.build = build;
  return validateBuildConfig(config);
};

describe('validateBuildConfig', () => {
  test('accepts a valid keyed config with no diagnostics', () => {
    const config = defineConfig({
      build: { pre: { a: { run: () => 1 } }, post: { b: { run: () => 2 } } },
    });
    expect(validateBuildConfig(config)).toEqual({ errors: [], warnings: [] });
  });

  test('errors when pre and post use different forms', () => {
    const { errors } = diagnose({ pre: { a: { run: () => {} } }, post: [{ name: 'b', run: () => {} }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('build.pre uses the object form');
    expect(errors[0]).toContain('build.post uses the array form');
  });

  test('allows one phase to be absent without a form clash', () => {
    const { errors } = diagnose({ post: { b: { run: () => {} } } });
    expect(errors).toEqual([]);
  });

  test('errors on an integer-like key', () => {
    const { errors } = diagnose({ pre: { '0': { run: () => {} } } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('is a number');
  });

  test('accepts keys that merely contain digits', () => {
    const { errors } = diagnose({ pre: { step1: { run: () => {} }, '1step': { run: () => {} } } });
    expect(errors).toEqual([]);
  });

  test('errors when run is not a function', () => {
    const { errors } = diagnose({ pre: { a: { run: 'nope' } as unknown as BuildStepMap[string] } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('build.pre.a.run must be a function');
  });

  test('errors when an array-form step has no run', () => {
    const { errors } = diagnose({ post: [{ name: 'a' } as unknown as BuildStep] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('build.post[0].run must be a function');
  });

  test('warns but does not error on the array form', () => {
    const { errors, warnings } = diagnose({ pre: [{ name: 'a', run: () => {} }] });
    expect(errors).toEqual([]);
    expect(warnings.some(w => w.includes('as arrays is deprecated'))).toBe(true);
  });

  test('does not warn about empty arrays', () => {
    const { warnings } = diagnose({ pre: [], post: [] });
    expect(warnings.some(w => w.includes('as arrays is deprecated'))).toBe(false);
  });

  test('warns about legacy steps', () => {
    const { warnings } = diagnose({ steps: [{ name: 'a', phase: 'pre', run: () => {} }] });
    expect(warnings.some(w => w.includes('build.steps is deprecated'))).toBe(true);
  });

  test('warns when a keyed config does not use defineConfig', () => {
    const { warnings } = diagnose({ post: { a: { run: () => {} } } });
    expect(warnings.some(w => w.includes('does not use defineConfig'))).toBe(true);
  });

  test('does not add the defineConfig nag on top of a deprecation warning', () => {
    const arrayForm = diagnose({ pre: [{ name: 'a', run: () => {} }] });
    expect(arrayForm.warnings.some(w => w.includes('does not use defineConfig'))).toBe(false);
    expect(arrayForm.warnings).toHaveLength(1);

    const legacy = diagnose({ steps: [{ name: 'a', run: () => {} }] });
    expect(legacy.warnings.some(w => w.includes('does not use defineConfig'))).toBe(false);
    expect(legacy.warnings).toHaveLength(1);
  });

  test('a keyed config built by defineConfig gets no nag', () => {
    const { warnings } = diagnose({ post: { a: { run: () => {} } } }, true);
    expect(warnings).toEqual([]);
  });

  test('stays quiet for a config with no steps at all', () => {
    expect(validateBuildConfig({ build: { cleanInstall: true } })).toEqual({ errors: [], warnings: [] });
    expect(validateBuildConfig({})).toEqual({ errors: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// defineConfig branding
// ---------------------------------------------------------------------------

describe('defineConfig', () => {
  test('brands its result', () => {
    expect(isDefinedConfig(defineConfig({}))).toBe(true);
  });

  test('a plain object is not branded', () => {
    expect(isDefinedConfig({ build: {} })).toBe(false);
    expect(isDefinedConfig(null)).toBe(false);
    expect(isDefinedConfig(undefined)).toBe(false);
  });

  test('the brand is non-enumerable so it does not leak into spreads or JSON', () => {
    const config = defineConfig({ build: { cleanInstall: true } });
    expect(Object.keys(config)).toEqual(['build']);
    expect(JSON.stringify(config)).toBe('{"build":{"cleanInstall":true}}');
  });
});

// ---------------------------------------------------------------------------
// Results threading
// ---------------------------------------------------------------------------

describe('results threading', () => {
  test('a pre step sees an earlier pre step result', async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(
      normalizeSteps({
        first: { run: () => ({ entries: 3 }) },
        second: {
          run: ({ results }) => {
            seen.push(results.pre.first);
            return null;
          },
        },
      }),
      'pre',
      ctx,
    );
    expect(seen).toEqual([{ entries: 3 }]);
  });

  test('post steps see all pre results and earlier post results', async () => {
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(normalizeSteps({ rustBuild: { run: () => ({ changed: true }) } }), 'pre', ctx);

    const seen: unknown[] = [];
    await runPhase(
      normalizeSteps({
        stamp: { run: () => ({ at: 42 }) },
        copy: {
          run: ({ results }) => {
            seen.push(results.pre.rustBuild, results.post.stamp);
            return undefined;
          },
        },
      }),
      'post',
      ctx,
    );

    expect(seen).toEqual([{ changed: true }, { at: 42 }]);
    expect(ctx.results.post).toEqual({ stamp: { at: 42 } });
  });

  test('a step returning nothing contributes no key', async () => {
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(
      normalizeSteps({
        quiet: { run: () => {} },
        loud: { run: () => 'value' },
      }),
      'pre',
      ctx,
    );
    expect(Object.keys(ctx.results.pre)).toEqual(['loud']);
    expect('quiet' in ctx.results.pre).toBe(false);
  });

  test('falsy results are still recorded', async () => {
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(
      normalizeSteps({ zero: { run: () => 0 }, no: { run: () => false }, empty: { run: () => '' } }),
      'pre',
      ctx,
    );
    expect(ctx.results.pre).toEqual({ zero: 0, no: false, empty: '' });
  });

  test('array-form steps contribute nothing', async () => {
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(normalizeSteps([{ name: 'legacy', run: () => ({ a: 1 }) }]), 'pre', ctx);
    expect(ctx.results.pre).toEqual({});
  });

  test('async and sync returns are both recorded', async () => {
    const ctx = ctxWith({ pre: {}, post: {} });
    await runPhase(
      normalizeSteps({
        syncStep: { run: () => 'sync' },
        asyncStep: { run: async () => 'async' },
      }),
      'pre',
      ctx,
    );
    expect(ctx.results.pre).toEqual({ syncStep: 'sync', asyncStep: 'async' });
  });
});
