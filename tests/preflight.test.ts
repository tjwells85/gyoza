import { describe, test, expect, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectEnv } from '../src/projectEnv.ts';
import {
  cleanEnvEntries,
  coerceVersion,
  evaluatePreflight,
  extractVersion,
  findLibrary,
  hasPreflight,
  isValidRange,
  reportPreflight,
  satisfiesRange,
  strictEnv,
  validatePreflightConfig,
} from '../src/preflight.ts';
import type {
  ExecResult,
  PreflightConfig,
  PreflightContext,
  PreflightEnv,
  PreflightExec,
} from '../src/preflight.ts';
import {
  check,
  findListenerPids,
  findMount,
  formatBytes,
  parseDfAvail,
  parseMountinfo,
  parseSize,
  unitFromCgroup,
} from '../src/checks.ts';

// ---------------------------------------------------------------------------
// Fakes — nothing here touches the real system
// ---------------------------------------------------------------------------

const ok = (stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode: 0, timedOut: false, notFound: false });
const exit = (exitCode: number, stderr = ''): ExecResult => ({ stdout: '', stderr, exitCode, timedOut: false, notFound: false });
const timedOut: ExecResult = { stdout: '', stderr: '', exitCode: null, timedOut: true, notFound: false };

/** Keyed by the argv joined with spaces (or the raw string for `sh -c` commands). */
const fakeExec =
  (responses: Record<string, ExecResult>): PreflightExec =>
  async (cmd) => {
    const key = typeof cmd === 'string' ? cmd : cmd.join(' ');
    return responses[key] ?? { stdout: '', stderr: `unexpected command: ${key}`, exitCode: 127, timedOut: false, notFound: true };
  };

const fakeEnv = (paths: Record<string, string>): PreflightEnv => ({ which: (cmd) => paths[cmd] ?? null });

const ctxWith = (
  exec: PreflightExec,
  services: string[] = [],
  serverEnv: Record<string, string> = {},
): PreflightContext => ({
  projectRoot: '/srv/app',
  changedFiles: [],
  fromRef: 'a1b2c3d',
  toRef: 'e4f5a6b',
  services,
  exec,
  serverEnv: strictEnv(serverEnv, 'server/.env'),
  frontendEnv: strictEnv({}, 'frontend/.env'),
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

describe('extractVersion', () => {
  test('takes the first dotted token by default', () => {
    expect(extractVersion('psql (PostgreSQL) 16.4 (Ubuntu 16.4-1.pgdg22.04+1)')).toBe('16.4');
    expect(extractVersion('Redis server v=7.2.4 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64')).toBe('7.2.4');
    expect(extractVersion('Valkey server v=8.0.1 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64')).toBe('8.0.1');
    expect(extractVersion('1.16.2\n')).toBe('1.16.2');
  });

  test('drops distro suffixes that semver would read as prereleases', () => {
    expect(extractVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023')).toBe('6.1.1');
  });

  test('does not match a bare number without a template', () => {
    expect(extractVersion('bits=64')).toBeUndefined();
  });

  test('a {version} template matches anywhere, allowing a dotless version', () => {
    expect(extractVersion('mytool 2024 Build 17 (linux)', 'Build {version} (')).toBe('17');
    expect(extractVersion('x\nmytool   Build 2.3.1   (linux)', 'Build {version} (')).toBe('2.3.1');
  });

  test('a template that never matches returns undefined', () => {
    expect(extractVersion('something else', 'Build {version} (')).toBeUndefined();
  });

  test('a RegExp uses capture group 1', () => {
    expect(extractVersion('server_version = 15.6', /server_version = (\S+)/)).toBe('15.6');
    expect(extractVersion('v=3.2.1 v=4.0.0', /v=(\d+\.\d+\.\d+)/g)).toBe('3.2.1');
  });
});

describe('coerceVersion / satisfiesRange', () => {
  test('pads and truncates to x.y.z', () => {
    expect(coerceVersion('16.4')).toBe('16.4.0');
    expect(coerceVersion('17')).toBe('17.0.0');
    expect(coerceVersion('v1.2.3.4')).toBe('1.2.3');
    expect(coerceVersion('nope')).toBeUndefined();
  });

  test('partial versions satisfy ranges after coercion', () => {
    expect(satisfiesRange('16.4', '>=15')).toBe(true);
    expect(satisfiesRange('14.2', '>=15')).toBe(false);
    expect(satisfiesRange('7.2.4', '>=7 <8')).toBe(true);
  });
});

describe('isValidRange', () => {
  test('accepts real ranges', () => {
    for (const range of ['>=15', '>=7 <9', '^1.2.3', '~2.1', '1.x', '*', '>=1.0.0 || ^3', '1.2 - 2.3', '=1.0.0']) {
      expect(isValidRange(range)).toBe(true);
    }
  });

  test('rejects garbage that Bun.semver.satisfies would wave through', () => {
    expect(Bun.semver.satisfies('1.0.0', 'garbage')).toBe(true); // why this guard exists
    for (const range of ['garbage', '', '>= fifteen', '15+', 'latest']) {
      expect(isValidRange(range)).toBe(false);
    }
  });
});

describe('findLibrary', () => {
  const ldconfig = [
    '1234 libs found in cache `/etc/ld.so.cache\'',
    '\tlibvips.so.42 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvips.so.42',
    '\tlibvips-cpp.so.42 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvips-cpp.so.42',
    '\tlibheif.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libheif.so.1',
  ].join('\n');

  test('accepts the name with or without lib, or a soname', () => {
    expect(findLibrary(ldconfig, 'vips')).toBe('libvips.so.42');
    expect(findLibrary(ldconfig, 'libheif')).toBe('libheif.so.1');
    expect(findLibrary(ldconfig, 'libheif.so.1')).toBe('libheif.so.1');
  });

  test('a prefix of another library is not a match', () => {
    expect(findLibrary(ldconfig.replace(/\tlibvips\.so.*\n/, ''), 'libvips')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// evaluatePreflight
// ---------------------------------------------------------------------------

describe('evaluatePreflight deps', () => {
  test('command defaults to the key and probes --version', async () => {
    const exec = fakeExec({ '/usr/bin/bun --version': ok('1.3.14\n') });
    const [outcome] = await evaluatePreflight({ deps: { bun: { version: '>=1.3' } } }, ctxWith(exec), fakeEnv({ bun: '/usr/bin/bun' }));
    expect(outcome).toEqual({ label: 'bun', ok: true, detail: '1.3.14 (>=1.3)', onFail: 'fail' });
  });

  test('reports the found version against the range on a mismatch', async () => {
    const exec = fakeExec({ '/usr/bin/psql --version': ok('psql (PostgreSQL) 14.2\n') });
    const [outcome] = await evaluatePreflight(
      { deps: { postgres: { command: 'psql', version: '>=15' } } },
      ctxWith(exec),
      fakeEnv({ psql: '/usr/bin/psql' }),
    );
    expect(outcome?.ok).toBe(false);
    expect(outcome?.detail).toBe('14.2, need >=15');
  });

  test('a missing command fails without probing', async () => {
    const [outcome] = await evaluatePreflight({ deps: { psql: { version: '>=15' } } }, ctxWith(fakeExec({})), fakeEnv({}));
    expect(outcome).toMatchObject({ ok: false, detail: 'psql not found on PATH' });
  });

  test('presence only when no version is given', async () => {
    const [outcome] = await evaluatePreflight({ deps: { ffmpeg: {} } }, ctxWith(fakeExec({})), fakeEnv({ ffmpeg: '/usr/bin/ffmpeg' }));
    expect(outcome).toMatchObject({ ok: true, detail: '/usr/bin/ffmpeg' });
  });

  test('a custom probe and template replace the defaults', async () => {
    const exec = fakeExec({ 'mytool info': ok('mytool\nBuild 2.4 (x86_64)\n') });
    const [outcome] = await evaluatePreflight(
      { deps: { weird: { command: 'mytool', version: { range: '>=2', probe: 'mytool info', match: 'Build {version} (' } } } },
      ctxWith(exec),
      fakeEnv({ mytool: '/opt/mytool' }),
    );
    expect(outcome).toMatchObject({ ok: true, detail: '2.4 (>=2)' });
  });

  test('version.get overrides probing', async () => {
    const [outcome] = await evaluatePreflight(
      { deps: { pg: { exists: () => true, version: { range: '>=15', get: () => '16.1' } } } },
      ctxWith(fakeExec({})),
      fakeEnv({}),
    );
    expect(outcome).toMatchObject({ ok: true, detail: '16.1 (>=15)' });
  });

  test('a probe with no version in its output fails with the first line', async () => {
    const exec = fakeExec({ '/usr/bin/x --version': exit(2, 'x: unknown option --version') });
    const [outcome] = await evaluatePreflight({ deps: { x: { version: '>=1' } } }, ctxWith(exec), fakeEnv({ x: '/usr/bin/x' }));
    expect(outcome?.detail).toBe('`/usr/bin/x --version`: exit 2 — x: unknown option --version');
  });

  test('a timed-out probe fails instead of hanging', async () => {
    const exec = fakeExec({ '/usr/bin/x --version': timedOut });
    const [outcome] = await evaluatePreflight({ deps: { x: { version: '>=1' } } }, ctxWith(exec), fakeEnv({ x: '/usr/bin/x' }));
    expect(outcome).toMatchObject({ ok: false, detail: '`/usr/bin/x --version` timed out' });
  });

  test('pkgConfig checks presence, then --modversion', async () => {
    const exec = fakeExec({
      '/usr/bin/pkg-config --exists libheif': ok(''),
      '/usr/bin/pkg-config --modversion libheif': ok('1.17.6\n'),
    });
    const [outcome] = await evaluatePreflight(
      { deps: { libheif: { pkgConfig: 'libheif', version: '>=1.16' } } },
      ctxWith(exec),
      fakeEnv({ 'pkg-config': '/usr/bin/pkg-config' }),
    );
    expect(outcome).toMatchObject({ ok: true, detail: '1.17.6 (>=1.16)' });
  });

  test('pkgConfig missing explains the -dev package', async () => {
    const exec = fakeExec({ '/usr/bin/pkg-config --exists libheif': exit(1) });
    const [outcome] = await evaluatePreflight(
      { deps: { libheif: { pkgConfig: 'libheif', onFail: 'warn' } } },
      ctxWith(exec),
      fakeEnv({ 'pkg-config': '/usr/bin/pkg-config' }),
    );
    expect(outcome).toMatchObject({ ok: false, onFail: 'warn' });
    expect(outcome?.detail).toContain('-dev/-devel');
  });

  test('library uses ldconfig -p, falling back to /sbin/ldconfig', async () => {
    const exec = fakeExec({ '/sbin/ldconfig -p': ok('\tlibvips.so.42 (libc6,x86-64) => /lib/libvips.so.42\n') });
    const [outcome] = await evaluatePreflight(
      { deps: { vips: { library: 'libvips' } } },
      ctxWith(exec),
      fakeEnv({ '/sbin/ldconfig': '/sbin/ldconfig' }),
    );
    expect(outcome).toMatchObject({ ok: true, detail: 'libvips.so.42' });
  });

  test('anyOf passes on the first alternative that passes and names it', async () => {
    const exec = fakeExec({ '/usr/bin/valkey-server --version': ok('Valkey server v=8.0.1 sha=0\n') });
    const [outcome] = await evaluatePreflight(
      {
        deps: {
          cache: {
            anyOf: {
              redis: { command: 'redis-server', version: '>=7' },
              valkey: { command: 'valkey-server', version: '>=7.2' },
            },
          },
        },
      },
      ctxWith(exec),
      fakeEnv({ 'valkey-server': '/usr/bin/valkey-server' }),
    );
    expect(outcome).toMatchObject({ label: 'cache', ok: true, detail: 'valkey 8.0.1 (>=7.2) — one of redis, valkey' });
  });

  test('anyOf failure lists why each alternative failed', async () => {
    const exec = fakeExec({ '/usr/bin/valkey-server --version': ok('Valkey server v=7.0.1\n') });
    const [outcome] = await evaluatePreflight(
      {
        deps: {
          cache: {
            onFail: 'warn',
            anyOf: {
              redis: { command: 'redis-server', version: '>=7' },
              valkey: { command: 'valkey-server', version: '>=7.2' },
            },
          },
        },
      },
      ctxWith(exec),
      fakeEnv({ 'valkey-server': '/usr/bin/valkey-server' }),
    );
    expect(outcome).toMatchObject({ ok: false, onFail: 'warn' });
    expect(outcome?.detail).toBe(
      'none of redis, valkey — redis: redis-server not found on PATH; valkey: 7.0.1, need >=7.2',
    );
  });
});

describe('evaluatePreflight checks', () => {
  test('a bare function and { run } both work; labels default to the key', async () => {
    const outcomes = await evaluatePreflight(
      { checks: { a: () => true, b: { name: 'Bee', run: () => ({ ok: false, detail: 'nope' }), onFail: 'warn' } } },
      ctxWith(fakeExec({})),
    );
    expect(outcomes).toEqual([
      { label: 'a', ok: true, detail: 'ok', onFail: 'fail' },
      { label: 'Bee', ok: false, detail: 'nope', onFail: 'warn' },
    ]);
  });

  test('a throw is a failure carrying the message, and later checks still run', async () => {
    const outcomes = await evaluatePreflight(
      {
        checks: {
          boom: () => {
            throw new Error('share offline');
          },
          after: async () => true,
        },
      },
      ctxWith(fakeExec({})),
    );
    expect(outcomes.map((o) => [o.label, o.ok, o.detail])).toEqual([
      ['boom', false, 'share offline'],
      ['after', true, 'ok'],
    ]);
  });

  test('a non-boolean return is a failure, not a silent pass', async () => {
    const [outcome] = await evaluatePreflight(
      { checks: { oops: (() => undefined) as unknown as () => boolean } },
      ctxWith(fakeExec({})),
    );
    expect(outcome?.ok).toBe(false);
    expect(outcome?.detail).toContain('expected a boolean or { ok }');
  });

  test('a check may return a check, which runs with the same context', async () => {
    const exec = fakeExec({ 'df -B1 --output=avail /mnt/media': ok(`Avail\n${30 * 1024 ** 3}\n`) });
    const [outcome] = await evaluatePreflight(
      { checks: { space: (ctx) => check.freeSpace(ctx.serverEnv.STORAGE_ROOT, '1GiB') } },
      ctxWith(exec, [], { STORAGE_ROOT: '/mnt/media' }),
    );
    expect(outcome).toMatchObject({ ok: true, detail: '30.0 GiB free at /mnt/media, need 1.0 GiB' });
  });

  test('an unset env var fails the check, naming the var and the file', async () => {
    const [outcome] = await evaluatePreflight(
      { checks: { media: (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT) } },
      ctxWith(fakeExec({})),
    );
    expect(outcome).toMatchObject({ ok: false, detail: 'STORAGE_ROOT is not set in server/.env' });
  });

  test('a check returning a check returning a check is an error, not a pass', async () => {
    const [outcome] = await evaluatePreflight({ checks: { deep: () => () => () => true } }, ctxWith(fakeExec({})));
    expect(outcome?.ok).toBe(false);
    expect(outcome?.detail).toContain('returned another check');
  });

  test('deps report before checks', async () => {
    const outcomes = await evaluatePreflight(
      { checks: { c: () => true }, deps: { d: { exists: () => true } } },
      ctxWith(fakeExec({})),
    );
    expect(outcomes.map((o) => o.label)).toEqual(['d', 'c']);
  });
});

describe('reportPreflight', () => {
  test('counts fail and warn separately and routes them to error / warn', () => {
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
    const warn = spyOn(console, 'warn').mockImplementation((m: string) => void warns.push(m));
    const error = spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));

    let summary;
    try {
      summary = reportPreflight([
        { label: 'postgres', ok: true, detail: '16.4 (>=15)', onFail: 'fail' },
        { label: 'libheif', ok: false, detail: 'not found', onFail: 'warn' },
        { label: 'media', ok: false, detail: '/mnt/media is not a mount point', onFail: 'fail' },
      ]);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }

    expect(summary).toEqual({ failed: 1, warned: 1 });
    expect(logs).toEqual(['  ✓ postgres  16.4 (>=15)']);
    expect(warns).toEqual(['  ⚠ libheif   not found']);
    expect(errors).toEqual(['  ✗ media     /mnt/media is not a mount point']);
  });
});

describe('hasPreflight', () => {
  test('empty or absent config is not a preflight', () => {
    expect(hasPreflight(undefined)).toBe(false);
    expect(hasPreflight({})).toBe(false);
    expect(hasPreflight({ deps: {}, checks: {} })).toBe(false);
    expect(hasPreflight({ checks: { a: () => true } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project env
// ---------------------------------------------------------------------------

describe('cleanEnvEntries', () => {
  test('strips export, matching quotes, and trailing comments on unquoted values', () => {
    expect(
      cleanEnvEntries({
        'export STORAGE_ROOT': '/mnt/media',
        QUOTED: '"/mnt/my share"',
        SINGLE: "'a # not a comment'",
        COMMENTED: '/mnt/x   # the share',
        HASH: 'abc#def',
        EMPTY: '',
      }),
    ).toEqual({
      STORAGE_ROOT: '/mnt/media',
      QUOTED: '/mnt/my share',
      SINGLE: 'a # not a comment',
      COMMENTED: '/mnt/x',
      HASH: 'abc#def',
      EMPTY: '',
    });
  });
});

describe('strictEnv', () => {
  const env = strictEnv({ PORT: '3000', EMPTY: '' }, 'server/.env');

  test('reads set keys, including empty ones', () => {
    expect(env.PORT).toBe('3000');
    expect(env.EMPTY).toBe('');
  });

  test('an unset env key throws, naming the file', () => {
    expect(() => env.STORAGE_ROOT).toThrow('STORAGE_ROOT is not set in server/.env');
  });

  test('`in` works for optional keys, and inspection keys do not throw', () => {
    expect('PORT' in env).toBe(true);
    expect('STORAGE_ROOT' in env).toBe(false);
    expect((env as Record<string, unknown>).then).toBeUndefined();
    expect(JSON.stringify(env)).toBe('{"PORT":"3000","EMPTY":""}');
  });

  test('is read-only', () => {
    expect(() => {
      (env as Record<string, string>).PORT = '1';
    }).toThrow();
  });
});

describe('loadProjectEnv', () => {
  test('server/.env overrides server/env.ts defaults; frontend reads frontend/.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gyoza-preflight-env-'));
    try {
      mkdirSync(join(dir, 'server'));
      mkdirSync(join(dir, 'frontend'));
      writeFileSync(
        join(dir, 'server/env.ts'),
        [
          "import { z } from 'zod';",
          'export const env = z.object({',
          "  STORAGE_ROOT: z.string().default('/mnt/media'),",
          "  PORT: z.coerce.number().default(3000),",
          '  DB_URL: z.string(),',
          '}).parse(process.env);',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'server/.env'), '# STORAGE_ROOT=/mnt/media\nPORT="4000"\nDB_URL=postgres://x\n');
      writeFileSync(join(dir, 'frontend/.env'), 'PUBLIC_API=/api\n');

      const { serverEnv, frontendEnv } = loadProjectEnv(dir);
      expect(serverEnv.STORAGE_ROOT).toBe('/mnt/media'); // from the default
      expect(serverEnv.PORT).toBe('4000'); // .env wins, quotes stripped
      expect(serverEnv.DB_URL).toBe('postgres://x');
      expect(frontendEnv.PUBLIC_API).toBe('/api');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing files give empty envs, not errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gyoza-preflight-env-'));
    try {
      const { serverEnv, frontendEnv } = loadProjectEnv(dir);
      expect(Object.keys(serverEnv)).toEqual([]);
      expect(Object.keys(frontendEnv)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validatePreflightConfig
// ---------------------------------------------------------------------------

describe('validatePreflightConfig', () => {
  const diagnose = (preflight: unknown): string[] => {
    const errors: string[] = [];
    validatePreflightConfig(preflight, errors);
    return errors;
  };

  test('accepts the documented shapes', () => {
    const config: PreflightConfig = {
      deps: {
        postgres: { command: 'psql', version: '>=15' },
        bun: { version: '>=1.3' },
        cache: { anyOf: { redis: { command: 'redis-server', version: '>=7' }, valkey: { command: 'valkey-server' } } },
        libheif: { pkgConfig: 'libheif', version: '>=1.16', onFail: 'warn' },
        vips: { library: 'libvips' },
        weird: { command: 'mytool', version: { range: '>=2', probe: ['mytool', 'info'], match: 'Build {version} (' } },
        custom: { exists: () => true, version: { range: '>=1', get: () => '1.0' } },
      },
      checks: { a: () => true, b: { run: () => true, onFail: 'warn' } },
    };
    expect(diagnose(config)).toEqual([]);
    expect(diagnose(undefined)).toEqual([]);
  });

  test('rejects an invalid range', () => {
    expect(diagnose({ deps: { pg: { version: 'garbage' } } })[0]).toContain('deploy.preflight.deps.pg.version must be a semver range');
  });

  test('rejects onFail values other than warn / fail', () => {
    expect(diagnose({ checks: { a: { run: () => true, onFail: 'continue' } } })[0]).toContain(
      "deploy.preflight.checks.a.onFail must be 'warn' or 'fail'",
    );
  });

  test('rejects more than one source', () => {
    expect(diagnose({ deps: { x: { command: 'x', library: 'libx' } } })[0]).toContain('sets command and library');
  });

  test('rejects a version on a library dep', () => {
    expect(diagnose({ deps: { x: { library: 'libx', version: '>=1' } } })[0]).toContain('presence-only');
  });

  test('an exists dep needs probe or get for a version', () => {
    expect(diagnose({ deps: { x: { exists: () => true, version: '>=1' } } })[0]).toContain('no default probe');
  });

  test('rejects a match template without the marker', () => {
    expect(diagnose({ deps: { x: { version: { range: '>=1', match: 'Build (' } } } })[0]).toContain('{version}');
  });

  test('anyOf: empty, nested, per-alternative onFail, stray fields', () => {
    expect(diagnose({ deps: { c: { anyOf: {} } } })[0]).toContain('at least one alternative');
    expect(diagnose({ deps: { c: { anyOf: { a: { anyOf: {} } } } } })[0]).toContain('cannot be nested');
    expect(diagnose({ deps: { c: { anyOf: { a: { onFail: 'warn' } } } } })[0]).toContain('ignored inside anyOf');
    expect(diagnose({ deps: { c: { version: '>=1', anyOf: { a: {} } } } })[0]).toContain('alongside anyOf');
  });

  test('a check must be a function or { run }', () => {
    expect(diagnose({ checks: { a: { name: 'x' } } })[0]).toContain('must be a function or { run: function }');
    expect(diagnose({ checks: [] })[0]).toContain('checks must be an object');
  });
});

// ---------------------------------------------------------------------------
// Built-in check helpers
// ---------------------------------------------------------------------------

describe('mountinfo', () => {
  const info = [
    '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '40 22 0:45 / /mnt/media rw,relatime shared:20 - nfs4 nas:/export/media rw,vers=4.2',
    '41 22 0:46 / /mnt/my\\040share rw - cifs //nas/share rw',
    '42 22 0:47 / /mnt/media rw master:3 - cifs //nas/other rw',
  ].join('\n');

  test('parses fields after the separator regardless of optional fields', () => {
    expect(parseMountinfo(info)[1]).toEqual({ mountPoint: '/mnt/media', fsType: 'nfs4', source: 'nas:/export/media' });
  });

  test('decodes octal escapes in paths', () => {
    expect(findMount(parseMountinfo(info), '/mnt/my share')?.fsType).toBe('cifs');
  });

  test('the last mount over a path wins', () => {
    expect(findMount(parseMountinfo(info), '/mnt/media')?.source).toBe('//nas/other');
  });

  test('a plain directory is not a mount', () => {
    expect(findMount(parseMountinfo(info), '/mnt')).toBeUndefined();
  });
});

describe('sizes', () => {
  test('parseSize: decimal for KB/MB/GB, binary for K/G/GiB', () => {
    expect(parseSize('20GB')).toBe(20_000_000_000);
    expect(parseSize('20G')).toBe(20 * 1024 ** 3);
    expect(parseSize('1.5 TiB')).toBe(1.5 * 1024 ** 4);
    expect(parseSize('512')).toBe(512);
    expect(parseSize(1024)).toBe(1024);
    expect(() => parseSize('lots')).toThrow(/not a size/);
    expect(() => parseSize('5PB')).toThrow(/not a size/);
  });

  test('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(20 * 1024 ** 3)).toBe('20.0 GiB');
  });

  test('parseDfAvail reads the second line', () => {
    expect(parseDfAvail('    Avail\n12345678\n')).toBe(12345678);
    expect(parseDfAvail('Avail\n')).toBeUndefined();
  });
});

describe('listener helpers', () => {
  test('findListenerPids dedupes pids from ss output', () => {
    const out =
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("bun",pid=1234,fd=12),("bun",pid=1235,fd=12))\n' +
      'LISTEN 0 511 [::]:3000 [::]:* users:(("bun",pid=1234,fd=13))';
    expect(findListenerPids(out)).toEqual([1234, 1235]);
    expect(findListenerPids('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*')).toEqual([]);
  });

  test('unitFromCgroup reads the service from cgroup v2 and v1 lines', () => {
    expect(unitFromCgroup('0::/system.slice/app.service\n')).toBe('app.service');
    expect(unitFromCgroup('12:pids:/system.slice/worker.service\n1:name=systemd:/system.slice/worker.service')).toBe(
      'worker.service',
    );
    expect(unitFromCgroup('0::/user.slice/user-1000.slice/session-2.scope')).toBeUndefined();
  });
});

describe('check factories', () => {
  test('freeSpace compares df output to the minimum', async () => {
    const exec = fakeExec({ 'df -B1 --output=avail /mnt/media': ok(`Avail\n${30 * 1024 ** 3}\n`) });
    expect(await check.freeSpace('/mnt/media', '20GiB')(ctxWith(exec))).toEqual({
      ok: true,
      detail: '30.0 GiB free at /mnt/media, need 20.0 GiB',
    });
    expect(await check.freeSpace('/mnt/media', '40G')(ctxWith(exec))).toMatchObject({ ok: false });
  });

  test('freeSpace reports a hung mount', async () => {
    const exec = fakeExec({ 'df -B1 --output=avail /mnt/media': timedOut });
    expect(await check.freeSpace('/mnt/media', '1G')(ctxWith(exec))).toMatchObject({
      ok: false,
      detail: 'df /mnt/media timed out — is the mount hung?',
    });
  });

  test('freeSpace with a bad size fails at run time, not at config load', async () => {
    const run = check.freeSpace('/mnt/media', 'lots'); // must not throw here
    const [outcome] = await evaluatePreflight({ checks: { space: run } }, ctxWith(fakeExec({})));
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome?.detail).toContain('not a size');
  });

  test('portFree passes on a free port', async () => {
    const exec = fakeExec({ 'ss -ltnpH sport = :3000': ok('') });
    expect(await check.portFree(3000)(ctxWith(exec))).toEqual({ ok: true, detail: 'port 3000 is free' });
  });

  test('portFree with a hidden listener assumes an active deploy.service', async () => {
    const exec = fakeExec({
      'ss -ltnpH sport = :3000': ok('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:*\n'),
      'systemctl is-active app.service': ok('active\n'),
    });
    expect(await check.portFree(3000)(ctxWith(exec, ['app.service']))).toMatchObject({ ok: true });
    expect(await check.portFree(3000)(ctxWith(exec, []))).toMatchObject({ ok: false });
  });

  test('portFree fails on a visible listener outside the service', async () => {
    // pid 1 is never in app.service's cgroup.
    const exec = fakeExec({ 'ss -ltnpH sport = :3000': ok('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("x",pid=1,fd=3))\n') });
    const result = await check.portFree(3000)(ctxWith(exec, ['app.service']));
    expect(result).toMatchObject({ ok: false });
  });

  test('serviceActive', async () => {
    const exec = fakeExec({ 'systemctl is-active postgresql': ok('inactive\n') });
    expect(await check.serviceActive('postgresql')(ctxWith(exec))).toEqual({
      ok: false,
      detail: 'postgresql is inactive',
    });
  });

  test('commandSucceeds', async () => {
    const exec = fakeExec({ 'test -w /mnt/media': exit(1, 'denied') });
    expect(await check.commandSucceeds('test -w /mnt/media')(ctxWith(exec))).toEqual({
      ok: false,
      detail: '`test -w /mnt/media` exited 1: denied',
    });
  });
});
