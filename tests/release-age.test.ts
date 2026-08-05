import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describeAge, readReleaseAgePolicy } from '../src/bunfig.ts';
import type { ReleaseAgePolicy } from '../src/bunfig.ts';
import { compareVersions, selectByReleaseAge } from '../src/version.ts';
import type { PublishTimesFetcher } from '../src/version.ts';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gyoza-release-age-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// compareVersions — now doing real semver prerelease ordering
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
  test('orders release cores', () => {
    expect(compareVersions('1.6.25', '1.6.26')).toBe(-1);
    expect(compareVersions('1.7.0', '1.6.26')).toBe(1);
    expect(compareVersions('1.6.26', '1.6.26')).toBe(0);
  });

  test('sorts a prerelease below its release', () => {
    expect(compareVersions('1.7.0-rc.4', '1.7.0')).toBe(-1);
  });

  test('orders prerelease identifiers numerically, not lexically', () => {
    expect(compareVersions('1.7.0-rc.4', '1.7.0-rc.10')).toBe(-1);
    expect(compareVersions('1.7.0-beta.9', '1.7.0-beta.10')).toBe(-1);
  });

  test('orders prerelease channels alphabetically', () => {
    expect(compareVersions('1.7.0-alpha.1', '1.7.0-beta.1')).toBe(-1);
    expect(compareVersions('1.7.0-beta.10', '1.7.0-rc.0')).toBe(-1);
  });

  test('a numeric identifier sorts below an alphanumeric one', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  test('a longer identifier list wins when prefixes match', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  test('ignores build metadata', () => {
    expect(compareVersions('1.0.0+build.1', '1.0.0')).toBe(0);
  });

  test('sorts an array correctly', () => {
    const sorted = ['1.6.26', '1.7.0-rc.4', '1.6.20', '1.7.0-beta.10', '1.7.0'].sort(compareVersions);
    expect(sorted).toEqual(['1.6.20', '1.6.26', '1.7.0-beta.10', '1.7.0-rc.4', '1.7.0']);
  });
});

// ---------------------------------------------------------------------------
// bunfig.toml
// ---------------------------------------------------------------------------

describe('readReleaseAgePolicy', () => {
  test('returns a disabled policy when there is no bunfig.toml', async () => {
    const policy = await readReleaseAgePolicy(cwd);
    expect(policy.minimumReleaseAge).toBe(0);
  });

  test('reads minimumReleaseAge and excludes from the project bunfig.toml', async () => {
    writeFileSync(
      join(cwd, 'bunfig.toml'),
      '[install]\nminimumReleaseAge = 432000\nminimumReleaseAgeExcludes = ["@types/bun", "typescript"]\n',
      'utf8',
    );

    const policy = await readReleaseAgePolicy(cwd);
    expect(policy.minimumReleaseAge).toBe(432000);
    expect(policy.excludes).toEqual(['@types/bun', 'typescript']);
  });

  test('a bunfig.toml without an [install] section is a disabled policy', async () => {
    writeFileSync(join(cwd, 'bunfig.toml'), '[test]\nroot = "test"\n', 'utf8');
    expect((await readReleaseAgePolicy(cwd)).minimumReleaseAge).toBe(0);
  });
});

describe('describeAge', () => {
  test('renders whole days', () => {
    expect(describeAge(432000)).toBe('5 days');
    expect(describeAge(86400)).toBe('1 day');
  });

  test('falls back to hours, then seconds', () => {
    expect(describeAge(3600)).toBe('1 hour');
    expect(describeAge(90)).toBe('90 seconds');
  });
});

// ---------------------------------------------------------------------------
// selectByReleaseAge — the fix for bun rejecting a too-new catalog version
// ---------------------------------------------------------------------------

describe('selectByReleaseAge', () => {
  const NOW = Date.parse('2026-08-05T00:00:00.000Z');
  const days = (n: number): string => new Date(NOW - n * 86400 * 1000).toISOString();

  // Mirrors the real better-auth situation: 1.6.26 published inside the window.
  const times: Record<string, string> = {
    created: days(400),
    modified: days(1),
    '1.6.20': days(46),
    '1.6.23': days(37),
    '1.6.24': days(14),
    '1.6.25': days(13),
    '1.6.26': days(1),
    '1.7.0-rc.3': days(9),
    '1.7.0-rc.4': days(1),
  };

  const fiveDays: ReleaseAgePolicy = { minimumReleaseAge: 432000, excludes: [] };

  const stub = (payload: Record<string, string> = times): PublishTimesFetcher => async () => payload;

  const explodes: PublishTimesFetcher = async () => {
    throw new Error('the registry must not be consulted when the gate is off');
  };

  test('drops to the newest release old enough to install', async () => {
    expect(await selectByReleaseAge('better-auth', '1.6.26', fiveDays, NOW, stub())).toBe('1.6.25');
  });

  test('keeps the latest when it is already old enough', async () => {
    expect(await selectByReleaseAge('better-auth', '1.6.25', fiveDays, NOW, stub())).toBe('1.6.25');
  });

  test('never drops a stable target to a prerelease', async () => {
    expect(await selectByReleaseAge('better-auth', '1.6.26', fiveDays, NOW, stub())).not.toContain('-');
  });

  test('keeps a prerelease target within prereleases', async () => {
    expect(await selectByReleaseAge('better-auth', '1.7.0-rc.4', fiveDays, NOW, stub())).toBe('1.7.0-rc.3');
  });

  test('never selects a version above the requested bound', async () => {
    expect(await selectByReleaseAge('better-auth', '1.6.23', fiveDays, NOW, stub())).toBe('1.6.23');
  });

  test('ignores the created/modified metadata keys', async () => {
    // 'modified' is 1 day old and would sort last if treated as a version.
    expect(await selectByReleaseAge('better-auth', '1.6.26', fiveDays, NOW, stub())).toBe('1.6.25');
  });

  test('is a no-op when no age gate is configured', async () => {
    const policy: ReleaseAgePolicy = { minimumReleaseAge: 0, excludes: [] };
    expect(await selectByReleaseAge('better-auth', '1.6.26', policy, NOW, explodes)).toBe('1.6.26');
  });

  test('is a no-op for an excluded package', async () => {
    const policy: ReleaseAgePolicy = { minimumReleaseAge: 432000, excludes: ['better-auth'] };
    expect(await selectByReleaseAge('better-auth', '1.6.26', policy, NOW, explodes)).toBe('1.6.26');
  });

  test('errors when nothing is old enough, naming the gate', async () => {
    const brandNew = { '1.0.0': days(1), '1.0.1': days(1) };
    await expect(selectByReleaseAge('fresh-pkg', '1.0.1', fiveDays, NOW, stub(brandNew))).rejects.toThrow(
      /minimumReleaseAge requires 5 days/,
    );
  });

  test('the error points at the excludes escape hatch', async () => {
    const brandNew = { '1.0.0': days(1) };
    await expect(selectByReleaseAge('fresh-pkg', '1.0.0', fiveDays, NOW, stub(brandNew))).rejects.toThrow(
      /minimumReleaseAgeExcludes/,
    );
  });
});
