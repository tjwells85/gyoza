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
      },
      checks: {
        media: check.mounted('/mnt/media'),
        space: { run: check.freeSpace('/mnt/media', '20GB'), onFail: 'warn' },
        port: check.portFree(3000),
        custom: { name: 'Uploads writable', run: async ({ exec }) => (await exec('test -w /mnt/media')).exitCode === 0 },
        detailed: () => ({ ok: true, detail: 'fine' }),
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
