import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PackageJson } from 'type-fest';
import { applyChanges, parseCatalogArgs, resolveTargets } from '../src/catalog.ts';
import { buildRemovePlan } from '../src/commands/remove.ts';
import { findCatalogConsumers, getCatalog, getWorkspaces, readPackageJson } from '../src/workspaces.ts';
import type { BunPackageJson } from '../src/workspaces.ts';

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

const plan = async (argv: string[], confirmPrune: (name: string, version: string) => Promise<boolean> = async () => true) => {
  const args = parseCatalogArgs(argv);
  const root = readRoot();
  const workspaces = getWorkspaces(root, cwd);
  const targets = resolveTargets(args.targets, workspaces);
  return buildRemovePlan(args, workspaces, targets, getCatalog(root), confirmPrune);
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'gyoza-catalog-remove-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('findCatalogConsumers', () => {
  test('lists only workspaces using the catalog: protocol', () => {
    makeFixture(
      { 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': '^4.1.0' } },
        shared: { devDependencies: { 'date-fns': 'catalog:' } },
      },
    );

    expect(findCatalogConsumers(getWorkspaces(readRoot(), cwd), 'date-fns')).toEqual(['server', 'shared']);
  });
});

describe('buildRemovePlan', () => {
  test('removes from the targeted workspaces only', async () => {
    makeFixture(
      { 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:' } },
        shared: { dependencies: { 'date-fns': 'catalog:' } },
      },
    );

    const result = await plan(['--catalog', 'shared', 'date-fns']);

    expect(result.workspaceChanges.map((c) => c.workspace)).toEqual(['shared']);
    expect(result.catalogChanges).toEqual([]);
  });

  test('prunes the catalog entry once no workspace references it', async () => {
    makeFixture(
      { hono: '^4.12.29', 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:' } },
      },
    );

    const result = await plan(['--catalog', 'server,frontend', 'date-fns']);

    expect(result.workspaceChanges.map((c) => c.workspace)).toEqual(['server', 'frontend']);
    expect(result.catalogChanges).toEqual([{ kind: 'remove', name: 'date-fns', from: '^4.4.0' }]);
  });

  test('declining the prune keeps the catalog entry', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { dependencies: { 'date-fns': 'catalog:' } } });

    const result = await plan(['--catalog', 'server', 'date-fns'], async () => false);

    expect(result.catalogChanges).toEqual([]);
    expect(result.kept).toEqual(['date-fns']);
  });

  test('removes from whichever section declares the package', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { devDependencies: { 'date-fns': 'catalog:' } } });

    const result = await plan(['--catalog', 'server', 'date-fns']);

    expect(result.workspaceChanges[0]?.section).toBe('devDependencies');
    expect(result.workspaceChanges[0]?.from).toBe('catalog:');
  });

  test('reports a package no targeted workspace declares', async () => {
    makeFixture({}, {});
    const result = await plan(['--catalog', 'shared', 'date-fns']);

    expect(result.notFound).toEqual(['date-fns']);
    expect(result.workspaceChanges).toEqual([]);
    expect(result.catalogChanges).toEqual([]);
  });

  test('handles several packages in one invocation, pruning each orphan', async () => {
    makeFixture(
      { hono: '^4.12.29', 'date-fns': '^4.4.0', zod: '^3.22.4' },
      {
        server: { dependencies: { 'date-fns': 'catalog:', zod: 'catalog:', hono: 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:', zod: 'catalog:' } },
      },
    );

    const result = await plan(['--catalog', 'server,frontend', 'date-fns', 'zod']);

    expect(result.workspaceChanges).toHaveLength(4);
    expect(result.catalogChanges).toEqual([
      { kind: 'remove', name: 'date-fns', from: '^4.4.0' },
      { kind: 'remove', name: 'zod', from: '^3.22.4' },
    ]);

    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    // hono still has a consumer, so it survives.
    expect(getCatalog(readRoot())).toEqual({ hono: '^4.12.29' });
    expect(readWorkspace('server').dependencies).toEqual({ hono: 'catalog:' });
    expect(readWorkspace('frontend').dependencies).toBeUndefined();
  });

  test('prunes only the orphans in a batch', async () => {
    makeFixture(
      { 'date-fns': '^4.4.0', zod: '^3.22.4' },
      {
        server: { dependencies: { 'date-fns': 'catalog:', zod: 'catalog:' } },
        shared: { dependencies: { zod: 'catalog:' } },
      },
    );

    const result = await plan(['--catalog', 'server', 'date-fns', 'zod']);

    // zod survives in shared; date-fns does not survive anywhere.
    expect(result.catalogChanges).toEqual([{ kind: 'remove', name: 'date-fns', from: '^4.4.0' }]);
  });

  test('a version suffix on the argument is ignored', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { dependencies: { 'date-fns': 'catalog:' } } });

    const result = await plan(['--catalog', 'server', 'date-fns@^4.4.0']);

    expect(result.workspaceChanges[0]?.name).toBe('date-fns');
  });
});

describe('applyChanges (remove)', () => {
  test('drops the dependency, the empty section, and the catalog entry', async () => {
    makeFixture(
      { hono: '^4.12.29', 'date-fns': '^4.4.0' },
      {
        server: { dependencies: { 'date-fns': 'catalog:' } },
        frontend: { dependencies: { 'date-fns': 'catalog:', hono: 'catalog:' } },
      },
    );

    const result = await plan(['--catalog', 'server,frontend', 'date-fns']);
    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    expect(getCatalog(readRoot())).toEqual({ hono: '^4.12.29' });
    expect(readWorkspace('server').dependencies).toBeUndefined();
    expect(readWorkspace('frontend').dependencies).toEqual({ hono: 'catalog:' });
  });

  test('drops the catalog field entirely once it is empty', async () => {
    makeFixture({ 'date-fns': '^4.4.0' }, { server: { dependencies: { 'date-fns': 'catalog:' } } });

    const result = await plan(['--catalog', 'server', 'date-fns']);
    applyChanges(cwd, result.catalogChanges, result.workspaceChanges);

    expect(readRoot().catalog).toBeUndefined();
  });
});
