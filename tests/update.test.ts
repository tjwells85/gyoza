import { describe, test, expect } from 'bun:test';
import { annotateOutdated, parseOutdatedTable, planCatalogUpdates } from '../src/commands/update.ts';
import type { CatalogTargetResolver } from '../src/commands/update.ts';
import { rangeOperator, resolveInRangeVersion } from '../src/version.ts';
import type { VersionsFetcher } from '../src/version.ts';

// ---------------------------------------------------------------------------
// planCatalogUpdates — bun cannot move a catalog entry, so gyoza re-resolves it
// ---------------------------------------------------------------------------

describe('planCatalogUpdates', () => {
  const catalog = {
    hono: '^4.12.33',
    'better-auth': '^1.6.25',
    'date-fns': '^4.4.0',
    typescript: '6.0.3', // exact pin
  };

  const bumpTo = (map: Record<string, string>): CatalogTargetResolver => async (name) => map[name];

  test('records only the entries whose resolved version differs', async () => {
    const updates = await planCatalogUpdates(
      catalog,
      true,
      false,
      bumpTo({ hono: '^4.12.33', 'better-auth': '^1.7.2', 'date-fns': '^4.4.0' }),
    );

    expect(updates).toEqual([{ name: 'better-auth', from: '^1.6.25', to: '^1.7.2' }]);
  });

  test('an undefined resolution leaves the entry alone', async () => {
    const updates = await planCatalogUpdates(catalog, false, false, async () => undefined);
    expect(updates).toEqual([]);
  });

  test('exact-pinned entries are protected unless --force', async () => {
    const resolve: CatalogTargetResolver = async (name) => (name === 'typescript' ? '^7.0.0' : undefined);

    expect(await planCatalogUpdates(catalog, true, false, resolve)).toEqual([]);
    expect(await planCatalogUpdates(catalog, true, true, resolve)).toEqual([
      { name: 'typescript', from: '6.0.3', to: '^7.0.0' },
    ]);
  });

  test('a resolver failure on one package does not abort the rest', async () => {
    const resolve: CatalogTargetResolver = async (name) => {
      if (name === 'better-auth') throw new Error('registry 500');
      return name === 'date-fns' ? '^4.5.0' : undefined;
    };

    const updates = await planCatalogUpdates(catalog, false, false, resolve);
    expect(updates).toEqual([{ name: 'date-fns', from: '^4.4.0', to: '^4.5.0' }]);
  });

  test('threads the --latest flag through to the resolver', async () => {
    const seen: boolean[] = [];
    await planCatalogUpdates({ hono: '^4.12.33' }, true, false, async (_n, _r, useLatest) => {
      seen.push(useLatest);
      return undefined;
    });
    expect(seen).toEqual([true]);
  });

  test('an empty catalog is a no-op', async () => {
    expect(await planCatalogUpdates({}, true, false, async () => '^9.9.9')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveInRangeVersion — the no-`--latest` path: newest release still in range
// ---------------------------------------------------------------------------

describe('resolveInRangeVersion', () => {
  const versions: VersionsFetcher = async () => [
    '1.6.20',
    '1.6.25',
    '1.6.30',
    '1.7.0-rc.1',
    '1.7.2',
    '2.0.0-beta.1',
    '2.0.0',
  ];

  test('picks the newest stable version satisfying the caret range', async () => {
    expect(await resolveInRangeVersion('better-auth', '^1.6.25', undefined, undefined, versions)).toBe('^1.7.2');
  });

  test('ignores prereleases and versions outside the range', async () => {
    expect(await resolveInRangeVersion('better-auth', '~1.6.25', undefined, undefined, versions)).toBe('~1.6.30');
  });

  test('an exact-version range only ever satisfies itself', async () => {
    expect(await resolveInRangeVersion('better-auth', '1.6.25', undefined, undefined, versions)).toBe('1.6.25');
  });

  test('returns the current version when nothing newer is in range', async () => {
    const only = async (): Promise<string[]> => ['1.6.25'];
    expect(await resolveInRangeVersion('better-auth', '^1.6.25', undefined, undefined, only)).toBe('^1.6.25');
  });

  test('returns undefined when no published version satisfies the range', async () => {
    const old = async (): Promise<string[]> => ['1.0.0', '1.2.0'];
    expect(await resolveInRangeVersion('better-auth', '^3.0.0', undefined, undefined, old)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseOutdatedTable — the ` *` release-age marker must not read as an update
// ---------------------------------------------------------------------------

describe('parseOutdatedTable', () => {
  test('parses a plain table', () => {
    const text = [
      'bun outdated v1.4.0 (34cbb9a40)',
      '|-------------------------------------------------------|',
      '| Package                 | Current | Update  | Latest  |',
      '|-------------------------|---------|---------|---------|',
      '| type-fest               | 5.6.0   | 5.9.0   | 5.9.0   |',
      '|-------------------------|---------|---------|---------|',
      '| typescript (dev)        | 6.0.3   | 6.0.3   | 7.0.2   |',
      '|-------------------------------------------------------|',
    ].join('\n');

    expect(parseOutdatedTable(text)).toEqual([
      { name: 'type-fest', current: '5.6.0', update: '5.9.0', latest: '5.9.0' },
      { name: 'typescript (dev)', current: '6.0.3', update: '6.0.3', latest: '7.0.2' },
    ]);
  });

  test('strips the ` *` minimum-release-age marker from version cells', () => {
    const text = [
      '| Package        | Current | Update  | Latest  |',
      '|----------------|---------|---------|---------|',
      '| zod (dev)      | 4.4.3   | 4.4.3 * | 4.4.3 * |',
      '|----------------|---------|---------|---------|',
      '| date-fns       | 4.4.0   | 4.4.0   | 4.5.1 * |',
      'Note: The * indicates that version isn\'t true latest due to minimum release age',
    ].join('\n');

    const parsed = parseOutdatedTable(text);
    expect(parsed[0]).toEqual({ name: 'zod (dev)', current: '4.4.3', update: '4.4.3', latest: '4.4.3' });
    // date-fns is genuinely behind — the marker is stripped but the row stands.
    expect(parsed[1]).toEqual({ name: 'date-fns', current: '4.4.0', update: '4.4.0', latest: '4.5.1' });
  });
});

// ---------------------------------------------------------------------------
// annotateOutdated — pinned rows are shown but flagged and not counted
// ---------------------------------------------------------------------------

describe('annotateOutdated', () => {
  const outdated = [
    { name: 'typescript (dev)', current: '6.0.3', update: '6.0.3', latest: '7.0.2' },
    { name: 'vite', current: '6.0.1', update: '6.3.5', latest: '6.3.5' },
  ];

  test('flags a pinned package, matching against its bare name', () => {
    const rows = annotateOutdated(outdated, true, new Set(['typescript']));
    expect(rows).toEqual([
      { name: 'typescript (dev)', current: '6.0.3', newVersion: '7.0.2', pinned: true },
      { name: 'vite', current: '6.0.1', newVersion: '6.3.5', pinned: false },
    ]);
  });

  test('uses the update column when not --latest', () => {
    const rows = annotateOutdated(outdated, false, new Set());
    expect(rows.map(r => r.newVersion)).toEqual(['6.0.3', '6.3.5']);
  });

  test('an empty pin set (e.g. --force) flags nothing', () => {
    expect(annotateOutdated(outdated, true, new Set()).every(r => !r.pinned)).toBe(true);
  });
});

describe('rangeOperator', () => {
  test.each([
    ['^1.6.25', '^'],
    ['~1.6.25', '~'],
    ['>=1.6.25', '>='],
    ['1.6.25', ''],
    ['  ^1.6.25', '^'],
  ])('%s -> %s', (range, op) => {
    expect(rangeOperator(range)).toBe(op);
  });
});
