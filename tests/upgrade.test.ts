import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changelogSince, findDeclaration } from '../src/commands/upgrade.ts';
import { compareVersions } from '../src/version.ts';

let cwd: string;

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gyoza-upgrade-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findDeclaration
// ---------------------------------------------------------------------------

describe('findDeclaration', () => {
  const makeFixture = (root: object, workspaces: Record<string, object> = {}): void => {
    writeJson(join(cwd, 'package.json'), { name: 'fixture', workspaces: Object.keys(workspaces), ...root });
    for (const [name, pkg] of Object.entries(workspaces)) {
      mkdirSync(join(cwd, name), { recursive: true });
      writeJson(join(cwd, name, 'package.json'), { name, ...pkg });
    }
  };

  test('finds gyoza in root devDependencies', () => {
    makeFixture({ devDependencies: { gyoza: 'github:tjwells85/gyoza' } });
    expect(findDeclaration(cwd)).toEqual({ dir: cwd, spec: 'github:tjwells85/gyoza' });
  });

  test('finds gyoza in root dependencies', () => {
    makeFixture({ dependencies: { gyoza: 'github:tjwells85/gyoza' } });
    expect(findDeclaration(cwd)?.spec).toBe('github:tjwells85/gyoza');
  });

  test('falls back to a workspace that declares it', () => {
    makeFixture({}, { server: { devDependencies: { gyoza: 'github:tjwells85/gyoza' } } });
    expect(findDeclaration(cwd)).toEqual({ dir: join(cwd, 'server'), spec: 'github:tjwells85/gyoza' });
  });

  test('prefers the root over a workspace', () => {
    makeFixture(
      { devDependencies: { gyoza: 'github:tjwells85/gyoza' } },
      { server: { devDependencies: { gyoza: 'github:someone/fork' } } },
    );
    expect(findDeclaration(cwd)?.dir).toBe(cwd);
  });

  test('returns undefined when nothing declares gyoza', () => {
    makeFixture({ devDependencies: { typescript: '^7.0.0' } });
    expect(findDeclaration(cwd)).toBeUndefined();
  });

  test('splits out an explicit ref', () => {
    makeFixture({ devDependencies: { gyoza: 'github:tjwells85/gyoza#v0.5.0' } });
    expect(findDeclaration(cwd)?.ref).toBe('v0.5.0');
  });

  test('leaves ref undefined when the spec has none', () => {
    makeFixture({ devDependencies: { gyoza: 'github:tjwells85/gyoza' } });
    expect(findDeclaration(cwd)?.ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compareVersions
// ---------------------------------------------------------------------------

describe('compareVersions', () => {
  test('orders by major, minor, then patch', () => {
    expect(compareVersions('0.5.0', '0.6.0')).toBe(-1);
    expect(compareVersions('0.6.0', '0.5.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.6.1', '0.6.0')).toBe(1);
  });

  test('treats equal versions as equal', () => {
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });

  test('sorts a prerelease before its release', () => {
    expect(compareVersions('0.6.0-alpha.0', '0.6.0')).toBe(-1);
    expect(compareVersions('0.6.0', '0.6.0-alpha.0')).toBe(1);
  });

  test('a downgrade is detectable', () => {
    expect(compareVersions('0.4.1', '0.5.0') > 0).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// changelogSince
// ---------------------------------------------------------------------------

describe('changelogSince', () => {
  const changelog = `# Changelog

## [0.7.0] - 2026-08-10

### Added

- newest thing

---

## [0.6.0] - 2026-08-05

### Fixed

- middle thing

---

## [0.5.0] - 2026-07-23

### Added

- oldest thing
`;

  test('collects every entry newer than the installed version', () => {
    const result = changelogSince(changelog, '0.5.0');
    expect(result).toContain('newest thing');
    expect(result).toContain('middle thing');
    expect(result).not.toContain('oldest thing');
  });

  test('stops at the installed version', () => {
    const result = changelogSince(changelog, '0.6.0');
    expect(result).toContain('newest thing');
    expect(result).not.toContain('middle thing');
  });

  test('returns everything when the installed version is not in the file', () => {
    const result = changelogSince(changelog, '0.1.0');
    expect(result).toContain('newest thing');
    expect(result).toContain('oldest thing');
  });

  test('returns an empty string when already at the newest entry', () => {
    expect(changelogSince(changelog, '0.7.0')).toBe('');
  });

  test('drops horizontal rules between entries', () => {
    expect(changelogSince(changelog, '0.5.0')).not.toContain('---');
  });

  test('keeps the version headings', () => {
    const result = changelogSince(changelog, '0.5.0');
    expect(result).toContain('## [0.7.0]');
    expect(result).toContain('## [0.6.0]');
  });
});
