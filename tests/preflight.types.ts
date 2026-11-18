/**
 * Type-level assertions for `deploy.preflight`. Nothing here runs — `tsc --noEmit`
 * enforces it via `bun run typecheck`.
 */
import { check } from '../src/checks.ts';
import { defineConfig } from '../src/config.ts';

defineConfig({
  deploy: {
    preflight: {
      deps: {
        postgres: { command: 'psql', version: '>=15' },
        bun: { version: '>=1.3' },
        cache: {
          anyOf: {
            redis: { command: 'redis-server', version: '>=7' },
            valkey: { command: 'valkey-server', version: '>=7.2' },
          },
        },
        libheif: { pkgConfig: 'libheif', version: '>=1.16', onFail: 'warn' },
        vips: { library: 'libvips' },
        weird: { command: 'mytool', version: { range: '>=2', probe: ['mytool', 'info'], match: /Build (\S+)/ } },
        custom: { exists: async () => true, version: { range: '>=1', get: async ({ exec }) => (await exec('x')).stdout } },
        remote: {
          command: 'psql',
          version: { range: '>=18', probe: (ctx) => ['psql', '-d', ctx.serverEnv.DATABASE_URL, '-tAc', 'show server_version'] },
        },
        remoteAsync: { command: 'valkey-cli', version: { range: '>=7.2', probe: async () => 'valkey-cli INFO server' } },
      },
      checks: {
        media: check.mounted('/mnt/media'),
        uploads: (ctx) => check.writable(ctx.serverEnv.STORAGE_ROOT),
        space: { run: check.freeSpace('/mnt/media', '20GB'), onFail: 'warn' },
        port: check.portFree(3000),
        custom: { name: 'Uploads writable', run: async ({ exec }) => (await exec('test -w /mnt/media')).exitCode === 0 },
        detailed: () => ({ ok: true, detail: 'fine' }),
        fromEnv: (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT),
        fromEnvAsync: { run: async ({ frontendEnv }) => check.freeSpace(frontendEnv.PUBLIC_UPLOADS, '1GB'), onFail: 'warn' },
      },
    },
  },
});

defineConfig({
  deploy: {
    preflight: {
      deps: {
        // @ts-expect-error — a library dep is presence-only
        vips: { library: 'libvips', version: '>=8' },
        // @ts-expect-error — one source per dep
        both: { command: 'x', pkgConfig: 'x' },
        cache: {
          anyOf: {
            // @ts-expect-error — only the group's onFail counts
            redis: { command: 'redis-server', onFail: 'warn' },
          },
        },
        // @ts-expect-error — 'continue' was dropped: a failure that prints nothing is no check
        quiet: { command: 'x', onFail: 'continue' },
      },
    },
  },
});
