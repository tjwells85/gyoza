import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PackageJson } from 'type-fest';
import { applyChanges, hasCatalogFlag, parseCatalogArgs, resolveTargets } from '../src/catalog.ts';
import { buildAddPlan } from '../src/commands/add.ts';
import type { VersionResolver } from '../src/commands/add.ts';
import { isPrerelease, isVersionOrRange, parsePackageSpec } from '../src/version.ts';
import { getCatalog, getWorkspaces, readPackageJson } from '../src/workspaces.ts';
import type { BunPackageJson } from '../src/workspaces.ts';

// ---------------------------------------------------------------------------
// Fixture — a monorepo shaped like a real hono-react-template project
// ---------------------------------------------------------------------------

let cwd: string;

const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
};

const makeFixture = (catalog: Record<string, string>, workspaceDeps: Record<string, PackageJson>): void => {
  writeJson(join(cwd, 'package.json'), {
    name: 'fixture',
    workspaces: ['server', 'frontend', 'shared'],
    catalog,
  });

  for (const name of ['server', 'frontend', 'shared']) {
    mkdirSync(join(cwd, name), { recursive: true });
    writeJson(join(cwd, name, 'package.json'), { name, ...(workspaceDeps[name] ?? {}) });
  }
};

const readRoot = (): BunPackageJson => readPackageJson(join(cwd, 'package.json'));
const readWorkspace = (name: string): PackageJson => readPackageJson<PackageJson>(join(cwd, name, 'package.json'));

const plan = async (
  argv: string[],
  resolve: VersionResolver,
  confirmBump: (name: string, from: string, to: string, consumers: string[]) => Promise<boolean> = async () => true,
) => {
  const args = parseCatalogArgs(argv);
  const root = readRoot();
  const workspaces = getWorkspaces(root, cwd);
  const targets = resolveTargets(args.targets, workspaces);
  return { args, plan: await buildAddPlan(args, workspaces, targets, getCatalog(root), confirmBump, resolve) };
};

const stubResolver = (versions: Record<string, string>): VersionResolver => async (spec) => {
  const version = versions[spec.spec ? `${spec.name}@${spec.spec}` : spec.name];
  if (!version) throw new Error(`stub resolver has no entry for ${spec.name}${spec.spec ? `@${spec.spec}` : ''}`);
  return version;
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gyoza-catalog-add-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

describe('parsePackageSpec', () => {
  test('bare name', () => {
    expect(parsePackageSpec('date-fns')).toEqual({ name: 'date-fns' });
  });

  test('name with version', () => {
    expect(parsePackageSpec('date-fns@^3.0.4')).toEqual({ name: 'date-fns', spec: '^3.0.4' });
  });

  test('scoped package without version', () => {
    expect(parsePackageSpec('@microsoft/microsoft-graph-client')).toEqual({ name: '@microsoft/microsoft-graph-client' });
  });

  test('scoped package with version splits on the last @', () => {
    expect(parsePackageSpec('@microsoft/microsoft-graph-client@^3.0.7')).toEqual({
      name: '@microsoft/microsoft-graph-client',
      spec: '^3.0.7',
    });
  });

  test('dist-tag', () => {
    expect(parsePackageSpec('react@next')).toEqual({ name: 'react', spec: 'next' });
  });
});

describe('isVersionOrRange', () => {
  test.each(['4.4.0', '^3.0.4', '~1.2.0', '>=2.0.0', 'v1.0.0', '3.x', '*', 'x', '1.0.0 - 2.0.0', '^1 || ^2'])(
    'treats %s as a version or range',
    (spec) => expect(isVersionOrRange(spec)).toBe(true),
  );

  test.each(['next', 'beta', 'latest', 'canary'])('treats %s as a dist-tag', (spec) =>
    expect(isVersionOrRange(spec)).toBe(false),
  );
});

describe('isPrerelease', () => {
  test('detects a prerelease', () => expect(isPrerelease('5.0.0-alpha.0')).toBe(true));
  test('ignores a stable version', () => expect(isPrerelease('4.4.0')).toBe(false));
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('parseCatalogArgs', () => {
  test('hasCatalogFlag detects both spellings', () => {
    expect(hasCatalogFlag(['--catalog', 'server', 'date-fns'])).toBe(true);
    expect(hasCatalogFlag(['--catalog=server', 'date-fns'])).toBe(true);
    expect(hasCatalogFlag(['date-fns'])).toBe(false);
  });

  test('splits a comma-separated workspace list', () => {
    const args = parseCatalogArgs(['--catalog', 'server,frontend,shared', 'date-fns']);
    expect(args.targets).toEqual(['server', 'frontend', 'shared']);
    expect(args.packages).toEqual(['date-fns']);
    expect(args.section).toBe('dependencies');
  });

  test('accepts --catalog=a,b', () => {
    expect(parseCatalogArgs(['--catalog=server,frontend', 'date-fns']).targets).toEqual(['server', 'frontend']);
  });

  test('maps section and modifier flags', () => {
    const args = parseCatalogArgs(['--catalog', 'server', '-d', '-E', '--dry', '-y', 'date-fns']);
    expect(args.section).toBe('devDependencies');
    expect(args.exact).toBe(true);
    expect(args.dry).toBe(true);
    expect(args.yes).toBe(true);
  });

  test('rejects bun flags it cannot honor', () => {
    expect(() => parseCatalogArgs(['--catalog', 'server', '--only-missing', 'date-fns'])).toThrow(/not supported with --catalog/);
    expect(() => parseCatalogArgs(['--catalog', 'server', '-a', 'date-fns'])).toThrow(/not supported with --catalog/);
  });

  test('rejects --catalog without a value', () => {
    expect(() => parseCatalogArgs(['--catalog', '--dry', 'date-fns'])).toThrow(/comma-separated list/);
  });

  test('rejects an empty package list', () => {
    expect(() => parseCatalogArgs(['--catalog', 'server'])).toThrow(/No packages given/);
  });
});

// ---------------------------------------------------------------------------
// Workspace discovery and validation
// ---------------------------------------------------------------------------

describe('workspace targeting', () => {
  test('lists workspaces that have a package.json', () => {
    makeFixture({}, {});
    expect(getWorkspaces(readRoot(), cwd).map((w) => w.name)).toEqual(['server', 'frontend', 'shared']);
  });

  test('skips declared workspaces with no package.json', () => {
    makeFixture({}, {});
    rmSync(join(cwd, 'shared'), { recursive: true });
    expect(getWorkspaces(readRoot(), cwd).map((w) => w.name)).toEqual(['server', 'frontend']);
  });

  test('errors on an unknown workspace, listing the valid ones', () => {
    makeFixture({}, {});
    const workspaces = getWorkspaces(readRoot(), cwd);
    expect(() => resolveTargets(['nope'], workspaces)).toThrow(/Unknown workspace "nope".*server, frontend, shared/);
  });

  test('root is not a valid target', () => {
    makeFixture({}, {});
    expect(() => resolveTargets(['root'], getWorkspaces(readRoot(), cwd))).toThrow(/Unknown workspace "root"/);
  });
});

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

describe('buildAddPlan', () => {
  test('adds a new package to the catalog and targets it in each workspace', async () => {
    makeFixture({ hono: '^4.12.29' }, {});
    const { plan: result } = await plan(['--catalog', 'server,frontend', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    expect(result.catalogChanges).toEqual([{ kind: 'add', name: 'date-fns', to: '^4.4.0' }]);
    expect(result.workspaceChanges.map((c) => c.workspace)).toEqual(['server', 'frontend']);
    expect(result.workspaceChanges.every((c) => c.section === 'dependencies')).toBe(true);
  });

  test('extending an existing entry never bumps the catalog and never resolves', async () => {
    makeFixture(
      { 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:' } },
      },
    );

    const neverCalled: VersionResolver = async () => {
      throw new Error('resolver must not be called when extending an existing catalog entry');
    };

    const { plan: result } = await plan(['--catalog', 'shared', 'date-fns'], neverCalled);

    expect(result.catalogChanges).toEqual([]);
    expect(result.unchanged).toEqual([{ name: 'date-fns', version: '^4.4.0' }]);
    expect(result.workspaceChanges.map((c) => c.workspace)).toEqual(['shared']);
  });

  test('a matching explicit version produces no catalog change', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, {});
    const { plan: result } = await plan(['--catalog', 'shared', 'date-fns@^4.4.0'], stubResolver({ 'date-fns@^4.4.0': '^4.4.0' }));

    expect(result.catalogChanges).toEqual([]);
    expect(result.unchanged).toEqual([{ name: 'date-fns', version: '^4.4.0' }]);
  });

  test('a differing explicit version prompts with the affected workspaces', async () => {
    makeFixture(
      { 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:' } },
      },
    );

    let seen: { from: string; to: string; consumers: string[] } | undefined;
    const { plan: result } = await plan(
      ['--catalog', 'shared', 'date-fns@^3.0.4'],
      stubResolver({ 'date-fns@^3.0.4': '^3.0.4' }),
      async (_name, from, to, consumers) => {
        seen = { from, to, consumers };
        return true;
      },
    );

    expect(seen).toEqual({ from: '^4.4.0', to: '^3.0.4', consumers: ['server', 'frontend'] });
    expect(result.catalogChanges).toEqual([{ kind: 'update', name: 'date-fns', from: '^4.4.0', to: '^3.0.4' }]);
  });

  test('declining the prompt skips the package entirely', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { dependencies: { 'date-fns': 'catalog:' } } });

    const { plan: result } = await plan(
      ['--catalog', 'shared', 'date-fns@^3.0.4'],
      stubResolver({ 'date-fns@^3.0.4': '^3.0.4' }),
      async () => false,
    );

    expect(result.catalogChanges).toEqual([]);
    expect(result.workspaceChanges).toEqual([]);
    expect(result.skipped).toEqual(['date-fns']);
  });

  test('skips a workspace already wired to the catalog in the target section', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { dependencies: { 'date-fns': 'catalog:' } } });
    const { plan: result } = await plan(['--catalog', 'server,shared', 'date-fns'], stubResolver({}));

    expect(result.workspaceChanges.map((c) => c.workspace)).toEqual(['shared']);
  });

  test('records the previous literal version a workspace declared', async () => {
    makeFixture({}, { frontend: { dependencies: { 'date-fns': '^4.1.0' } } });
    const { plan: result } = await plan(['--catalog', 'frontend', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    expect(result.workspaceChanges[0]?.from).toBe('^4.1.0');
  });

  test('-d targets devDependencies', async () => {
    makeFixture({}, {});
    const { plan: result } = await plan(['--catalog', 'server', '-d', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    expect(result.workspaceChanges[0]?.section).toBe('devDependencies');
  });
});

// ---------------------------------------------------------------------------
// Applying changes
// ---------------------------------------------------------------------------

describe('applyChanges (add)', () => {
  test('appends to the catalog without re-sorting and wires the workspaces', async () => {
    makeFixture({ hono: '^4.12.29', zod: '^4.4.3' }, {});
    const { plan: result } = await plan(['--catalog', 'server,frontend', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    expect(Object.keys(getCatalog(readRoot()))).toEqual(['hono', 'zod', 'date-fns']);
    expect(readWorkspace('server').dependencies).toEqual({ 'date-fns': 'catalog:' });
    expect(readWorkspace('frontend').dependencies).toEqual({ 'date-fns': 'catalog:' });
    expect(readWorkspace('shared').dependencies).toBeUndefined();
  });

  test('moving between sections leaves no duplicate behind', async () => {
    makeFixture({}, { server: { dependencies: { 'date-fns': '^4.1.0' } } });
    const { plan: result } = await plan(['--catalog', 'server', '-d', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    const pkg = readWorkspace('server');
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toEqual({ 'date-fns': 'catalog:' });
  });

  test('writes package.json with a trailing newline', async () => {
    makeFixture({}, {});
    const { plan: result } = await plan(['--catalog', 'server', 'date-fns'], stubResolver({ 'date-fns': '^4.4.0' }));

    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    expect(readFileSync(join(cwd, 'package.json'), 'utf8').endsWith('}\n')).toBe(true);
    expect(readFileSync(join(cwd, 'server', 'package.json'), 'utf8').endsWith('}\n')).toBe(true);
  });
});
