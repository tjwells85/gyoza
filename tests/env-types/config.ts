/**
 * Type-level assertions for `ctx.serverEnv` in a project that augments `Bun.Env`.
 * Its own program (tsconfig.json here), because the augmentation is global: in the
 * root program it would hide the untyped fallback. Run by tests/env-types.test.ts.
 */
import type { ProjectEnv } from '../../src/preflight.ts';
import { check } from '../../src/checks.ts';
import { defineConfig } from '../../src/config.ts';
import './env.ts';

defineConfig({
  deploy: {
    preflight: {
      deps: {
        postgres: {
          command: 'psql',
          version: { range: '>=18', probe: (ctx) => ['psql', '-d', ctx.serverEnv.STORAGE_ROOT, '-tAc', 'show server_version'] },
        },
      },
      checks: {
        storage: (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT),
        // Raw .env text: a coerced number is still a string.
        port: (ctx) => check.portFree(Number(ctx.serverEnv.PORT)),
        optional: ({ serverEnv }) => ('SYNCTHING_URL' in serverEnv ? check.commandSucceeds(`curl -sf ${serverEnv.SYNCTHING_URL}`) : true),
        bunDeclared: ({ serverEnv }) => serverEnv.NODE_ENV === 'production',
        types: ({ serverEnv }) => {
          const port: string = serverEnv.PORT;
          const devMode: string = serverEnv.DEV_MODE;
          // @ts-expect-error — values are strings, not the Zod output types
          const asNumber: number = serverEnv.PORT;
          // @ts-expect-error — a key the schema doesn't declare is a typo
          const typo = serverEnv.STORAGE_ROT;
          // @ts-expect-error — read-only
          serverEnv.PORT = '1';
          // The untyped form is still reachable for a key outside the schema.
          const other = (serverEnv as ProjectEnv).OTHER;
          return [port, devMode, asNumber, typo, other].length > 0;
        },
      },
    },
  },
});
