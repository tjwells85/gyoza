/**
 * Type-level assertions for `defineConfig`. Nothing here runs — `tsc --noEmit`
 * covers the whole repo, so `bun run typecheck` is what enforces these.
 *
 * The thing most worth guarding: `results.pre.<key>` in a post step must be the
 * exact type the pre step returned. If the inference regresses it degrades to
 * `unknown` rather than erroring at the definition site, so an explicit
 * equality check is the only thing that catches it.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- params here are read by typeof only */
import { defineConfig } from '../src/config.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(_value: T): void => {};

defineConfig({
  build: {
    pre: {
      rustBuild: {
        name: 'Build Rust CLI',
        run: async ({ buildDir, results }) => {
          // Fallback A: pre-phase results are untyped by design. Typing this as
          // Partial<TPre> collapses this step's own return type to `unknown`.
          expectType<Equal<typeof results.pre, Record<string, unknown>>>(true);
          expectType<Equal<typeof results.post, Record<string, never>>>(true);
          return { changed: true, artifact: `${buildDir}/mycli` };
        },
      },
      manifest: { run: () => ({ entries: 3 }) },
      quiet: {
        run: async () => {
          /* returns nothing */
        },
      },
    },
    post: {
      copyCli: {
        run: async ({ results }) => {
          expectType<Equal<typeof results.pre.rustBuild, { changed: boolean; artifact: string }>>(true);
          expectType<Equal<typeof results.pre.manifest, { entries: number }>>(true);
          expectType<Equal<typeof results.pre.quiet, void>>(true);
          // Same-phase results are readable but untyped.
          expectType<Equal<typeof results.post, Record<string, unknown>>>(true);
          return { skipped: !results.pre.rustBuild.changed };
        },
      },
      stamp: { run: () => ({ at: Date.now() }) },
    },
  },
});

// The ordinary context fields survive alongside `results`.
defineConfig({
  build: {
    post: {
      paths: {
        run: ({ projectRoot, buildDir }) => {
          expectType<Equal<typeof projectRoot, string>>(true);
          expectType<Equal<typeof buildDir, string>>(true);
          return null;
        },
      },
    },
  },
});

// A config with no build steps still type-checks.
defineConfig({ build: { cleanInstall: true, typecheck: 'fail' } });
defineConfig({ custom: { init: { seed: async () => {} } } });

// The deploy block: migrate as a script name or a callback, service as a string or array.
defineConfig({ deploy: { migrate: 'db:migrate', service: 'app' } });
defineConfig({
  deploy: {
    service: ['app', 'worker.service'],
    migrate: (ctx) => {
      expectType<Equal<typeof ctx.projectRoot, string>>(true);
      expectType<Equal<typeof ctx.changedFiles, string[]>>(true);
      expectType<Equal<typeof ctx.fromRef, string>>(true);
      expectType<Equal<typeof ctx.toRef, string>>(true);
    },
  },
});

// The deprecated array form must stay assignable, so a config can be wrapped in
// defineConfig as its own migration step before its steps are keyed.
defineConfig({
  build: {
    pre: [{ name: 'Generate types', run: async () => {} }],
    post: [{ name: 'Copy CLI', run: async () => {} }],
    steps: [{ name: 'Ancient', phase: 'pre', run: async () => {} }],
  },
});
