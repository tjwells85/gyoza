import { $ } from 'bun';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
import { readReleaseAgePolicy } from '../bunfig.ts';
import type { ReleaseAgePolicy } from '../bunfig.ts';
import type { CommandFlag } from '../gyoza.ts';
import { resolveCatalogVersion, resolveInRangeVersion } from '../version.ts';

// Phrased to contrast with `gyoza upgrade`, which updates gyoza itself.
export const description = 'Interactive updater for your project dependencies';

export const flags: CommandFlag[] = [
  { flag: '--latest', description: 'Update to latest versions (ignores semver range)' },
  { flag: '-y, --yes', description: 'Skip confirmation prompt' },
  { flag: '--force', description: 'Ignore pinned versions and update them like any other package' },
];

type BunPackageJson = PackageJson & { catalog: Record<string, string> };

const rootPackagePath = join(process.cwd(), 'package.json');
const frontendPackagePath = join(process.cwd(), 'frontend', 'package.json');
const serverPackagePath = join(process.cwd(), 'server', 'package.json');
const sharedPackagePath = join(process.cwd(), 'shared', 'package.json');

const getCatalogPackages = async (): Promise<Map<string, string>> => {
  const catalogMap = new Map<string, string>();
  const rootPackage: BunPackageJson = await Bun.file(rootPackagePath).json();
  const catalog = rootPackage.catalog || {};

  for (const [pkg, version] of Object.entries(catalog)) {
    catalogMap.set(pkg, version);
  }

  return catalogMap;
};

type PinnedEntry = {
  file: string;
  section: 'dependencies' | 'devDependencies' | 'catalog';
  name: string;
  version: string;
};

// Exact version, e.g. "6.0.3" — not a range, tag, or protocol like "catalog:"/"workspace:*".
const isPinnedVersion = (version: string): boolean => /^\d+\.\d+\.\d+/.test(version.trim());

const collectPinnedEntries = async (packagePath: string): Promise<PinnedEntry[]> => {
  const file = Bun.file(packagePath);
  if (!(await file.exists())) return [];

  const pkg: BunPackageJson = await file.json();
  const entries: PinnedEntry[] = [];

  const scan = (section: 'dependencies' | 'devDependencies' | 'catalog', deps?: Partial<Record<string, string>>) => {
    if (!deps) return;
    for (const [name, version] of Object.entries(deps)) {
      if (version && isPinnedVersion(version)) {
        entries.push({ file: packagePath, section, name, version });
      }
    }
  };

  scan('dependencies', pkg.dependencies);
  scan('devDependencies', pkg.devDependencies);
  scan('catalog', pkg.catalog);

  return entries;
};

const collectAllPinnedEntries = async (): Promise<PinnedEntry[]> => {
  const paths = [rootPackagePath, frontendPackagePath, serverPackagePath, sharedPackagePath];
  const results = await Promise.all(paths.map(collectPinnedEntries));
  return results.flat();
};

const restorePinnedEntries = async (entries: PinnedEntry[]): Promise<void> => {
  if (entries.length === 0) return;

  const byFile = new Map<string, PinnedEntry[]>();
  for (const entry of entries) {
    const list = byFile.get(entry.file) ?? [];
    list.push(entry);
    byFile.set(entry.file, list);
  }

  for (const [file, fileEntries] of byFile.entries()) {
    const pkg: BunPackageJson = await Bun.file(file).json();
    let changed = false;

    for (const { section, name, version } of fileEntries) {
      const deps = pkg[section] as Record<string, string> | undefined;
      if (deps && deps[name] !== undefined && deps[name] !== version) {
        deps[name] = version;
        changed = true;
      }
    }

    if (changed) {
      await Bun.write(file, JSON.stringify(pkg, null, 2));
      console.log(`Restored pinned versions in ${file}.`);
    }
  }
};

export type CatalogUpdate = { name: string; from: string; to: string };

/**
 * Resolves a root `catalog` entry to the version it should move to, or undefined
 * when it should stay put. Injectable so tests need no registry.
 */
export type CatalogTargetResolver = (name: string, currentRange: string, useLatest: boolean) => Promise<string | undefined>;

/**
 * Work out which root `catalog` entries move, and where to.
 *
 * Bun has no affordance for updating a catalog — `bun update` cannot see or
 * rewrite the root `catalog` object — so the versions are re-resolved here the
 * same way a standard dependency would move: `--latest` goes to the absolute
 * latest, a plain run goes to the newest release still inside the current range.
 * Exact-pinned entries are protected exactly as they are elsewhere in this
 * command; `--force` opts them back in.
 */
export const planCatalogUpdates = async (
  catalog: Record<string, string>,
  useLatest: boolean,
  force: boolean,
  resolve: CatalogTargetResolver,
): Promise<CatalogUpdate[]> => {
  const updates: CatalogUpdate[] = [];

  for (const [name, current] of Object.entries(catalog)) {
    if (!force && isPinnedVersion(current)) continue;

    let target: string | undefined;
    try {
      target = await resolve(name, current, useLatest);
    } catch (err) {
      console.warn(`  ⚠ Could not resolve ${name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (target && target !== current) updates.push({ name, from: current, to: target });
  }

  return updates;
};

const makeCatalogResolver = (policy: ReleaseAgePolicy, notes: string[]): CatalogTargetResolver => {
  const note = (msg: string): void => {
    notes.push(`  · ${msg}`);
  };
  return (name, currentRange, useLatest) =>
    useLatest
      ? resolveCatalogVersion({ name }, false, policy, note)
      : resolveInRangeVersion(name, currentRange, policy, note);
};

const printCatalogUpdates = (updates: CatalogUpdate[]): void => {
  if (updates.length === 0) return;

  console.log('\nCatalog (package.json)');
  const nameWidth = Math.max(10, ...updates.map(u => u.name.length));
  const fromWidth = Math.max(7, ...updates.map(u => u.from.length));
  const totalWidth = nameWidth + fromWidth + 12;

  console.log('─'.repeat(totalWidth));
  console.log(`${'Package'.padEnd(nameWidth)}  ${'Current'.padEnd(fromWidth)}  New Version`);
  console.log('─'.repeat(totalWidth));

  for (const u of updates) {
    console.log(`${u.name.padEnd(nameWidth)}  ${u.from.padEnd(fromWidth)}  ${u.to}`);
  }
};

export type OutdatedPackage = {
  name: string;
  current: string;
  update: string;
  latest: string;
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * `bun outdated` appends ` *` to an Update/Latest version when a newer release
 * exists but is held back by `minimumReleaseAge` — the shown version is the
 * newest one actually installable. For gyoza's purposes that version *is* the
 * target, so the marker is stripped; otherwise `"4.4.3 *" !== "4.4.3"` makes an
 * up-to-date package look outdated.
 */
const cleanVersionCell = (cell: string): string => cell.replace(/\s*\*\s*$/, '').trim();

/** `"@types/bun (dev)"` → `"@types/bun"`, for matching against catalog keys. */
const bareName = (name: string): string => name.replace(/\s*\((?:dev|peer|optional)\)\s*$/, '').trim();

export const parseOutdatedTable = (text: string): OutdatedPackage[] => {
  const packages: OutdatedPackage[] = [];
  let foundHeader = false;

  for (const raw of text.split('\n')) {
    const line = stripAnsi(raw);
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (!foundHeader) {
      if (cells[0]?.toLowerCase() === 'package') foundHeader = true;
      continue;
    }
    if (cells[0]?.startsWith('-')) continue;
    if (cells.length >= 4) {
      packages.push({
        name: cells[0],
        current: cleanVersionCell(cells[1]),
        update: cleanVersionCell(cells[2]),
        latest: cleanVersionCell(cells[3]),
      });
    }
  }

  return packages;
};

const getWorkspaceOutdated = async (cwd: string): Promise<OutdatedPackage[]> => {
  const text = await $`bun outdated`.cwd(cwd).nothrow().text();
  return parseOutdatedTable(text);
};

export type OutdatedRow = { name: string; current: string; newVersion: string; pinned: boolean };

/**
 * Pair each outdated package with the version it would move to and whether it is
 * pinned. A pinned package is still listed — it has a newer version and that is
 * worth seeing — but `restorePinnedEntries` reverts any bump, so it does not
 * count as an update (unless `--force` emptied `pinnedNames`).
 */
export const annotateOutdated = (
  updatable: OutdatedPackage[],
  useLatest: boolean,
  pinnedNames: Set<string>,
): OutdatedRow[] =>
  updatable.map(pkg => ({
    name: pkg.name,
    current: pkg.current,
    newVersion: useLatest ? pkg.latest : pkg.update,
    pinned: pinnedNames.has(bareName(pkg.name)),
  }));

const printWorkspaceOutdated = (label: string, rows: OutdatedRow[]): void => {
  if (rows.length === 0) return;

  console.log(`\nWorkspace: ${label}`);

  const display = rows.map(r => ({
    name: r.name,
    current: r.current,
    newVersion: r.pinned ? `${r.newVersion}  (pinned, not updated)` : r.newVersion,
  }));

  const nameWidth = Math.max(10, ...display.map(r => r.name.length));
  const currentWidth = Math.max(9, ...display.map(r => r.current.length));
  const newWidth = Math.max(11, ...display.map(r => r.newVersion.length));
  const totalWidth = nameWidth + currentWidth + newWidth + 6;

  console.log('─'.repeat(totalWidth));
  console.log(`${'Package'.padEnd(nameWidth)}  ${'Current'.padEnd(currentWidth)}  New Version`);
  console.log('─'.repeat(totalWidth));

  for (const row of display) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.current.padEnd(currentWidth)}  ${row.newVersion}`);
  }
};

const printPinnedNotice = (pinnedEntries: PinnedEntry[], latestByName: Map<string, string>): void => {
  const seen = new Set<string>();
  const rows = pinnedEntries
    .filter(entry => !seen.has(entry.name) && seen.add(entry.name))
    .map(entry => ({ name: entry.name, pinned: entry.version, latest: latestByName.get(entry.name) }))
    .filter((row): row is { name: string; pinned: string; latest: string } => !!row.latest && row.latest !== row.pinned);

  if (rows.length === 0) return;

  const nameWidth = Math.max(10, ...rows.map(r => r.name.length));
  const pinnedWidth = Math.max(6, ...rows.map(r => r.pinned.length));
  const totalWidth = nameWidth + pinnedWidth + 12;

  console.log('Pinned versions (protected — pass --force to update anyway):');
  console.log('─'.repeat(totalWidth));
  console.log(`${'Package'.padEnd(nameWidth)}  ${'Pinned'.padEnd(pinnedWidth)}  Latest`);
  console.log('─'.repeat(totalWidth));

  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.pinned.padEnd(pinnedWidth)}  ${row.latest}`);
  }

  console.log('');
};

type OutdatedReport = {
  /** Packages that will actually move — what the confirmation prompt counts. */
  actionable: number;
  /** Packages with a newer version that stays put because they are pinned. */
  pinnedPending: number;
};

const showOutdatedReport = async (
  useLatest: boolean,
  pinnedEntries: PinnedEntry[],
  force: boolean,
  suppressUpToDate: boolean,
  catalogNames: Set<string>,
): Promise<OutdatedReport> => {
  const workspaces = [
    { label: 'root', cwd: process.cwd() },
    { label: 'frontend', cwd: join(process.cwd(), 'frontend') },
    { label: 'server', cwd: join(process.cwd(), 'server') },
    { label: 'shared', cwd: join(process.cwd(), 'shared') },
  ];

  console.log('Checking for outdated packages...');

  const results = await Promise.all(
    workspaces.map(async w => {
      const all = await getWorkspaceOutdated(w.cwd);
      // Catalogued packages are owned by planCatalogUpdates — keep them out of
      // the workspace table so a catalog bump isn't reported (and counted) twice.
      const updatable = all.filter(
        p => !catalogNames.has(bareName(p.name)) && (useLatest ? p.latest : p.update) !== p.current,
      );
      return { label: w.label, all, updatable };
    }),
  );

  const pinnedNames = new Set(pinnedEntries.map(e => e.name));

  if (!force && pinnedEntries.length > 0) {
    const latestByName = new Map<string, string>();
    for (const { all } of results) {
      for (const pkg of all) {
        const key = bareName(pkg.name);
        if (!latestByName.has(key)) latestByName.set(key, pkg.latest);
      }
    }
    printPinnedNotice(pinnedEntries, latestByName);
  }

  const annotated = results.map(r => ({ label: r.label, rows: annotateOutdated(r.updatable, useLatest, pinnedNames) }));
  const anyRows = annotated.some(r => r.rows.length > 0);

  // Pinned packages have a newer version but won't move — don't count them
  // toward the prompt, or "N updates" overstates what will actually change.
  let actionable = 0;
  let pinnedPending = 0;
  for (const { rows } of annotated) {
    for (const row of rows) {
      if (row.pinned) pinnedPending++;
      else actionable++;
    }
  }

  if (!anyRows) {
    if (!suppressUpToDate) console.log('All packages are up to date.\n');
    return { actionable: 0, pinnedPending: 0 };
  }

  for (const { label, rows } of annotated) {
    printWorkspaceOutdated(label, rows);
  }

  console.log('');
  return { actionable, pinnedPending };
};

const confirmUpdate = async (count: number): Promise<boolean> => {
  process.stdout.write(`${count} update${count === 1 ? '' : 's'} available. Proceed? [Y/n] `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  }

  return false;
};

const runUpdates = async (latest: boolean): Promise<void> => {
  const updateArgs = ['bun', 'update'];
  if (latest) updateArgs.push('--latest');

  console.log('Running bun update in root...');
  await Bun.spawn(updateArgs, { cwd: process.cwd(), stdout: 'inherit' }).exited;

  console.log('Running bun update in frontend...');
  await Bun.spawn(updateArgs, { cwd: join(process.cwd(), 'frontend'), stdout: 'inherit' }).exited;

  console.log('Running bun update in server...');
  await Bun.spawn(updateArgs, { cwd: join(process.cwd(), 'server'), stdout: 'inherit' }).exited;

  console.log('Running bun update in shared...');
  await Bun.spawn(updateArgs, { cwd: join(process.cwd(), 'shared'), stdout: 'inherit' }).exited;
};

const catalogifyWorkspaceDependencies = async (packagePath: string, catalogMap: Map<string, string>): Promise<void> => {
  const pkg: PackageJson = await Bun.file(packagePath).json();
  let updated = false;

  const updateDeps = (deps?: Partial<Record<string, string>>) => {
    if (!deps) return;
    for (const [name, version] of Object.entries(deps)) {
      const catalogVersion = catalogMap.get(name);
      if (catalogVersion && version !== 'catalog:') {
        deps[name] = 'catalog:';
        updated = true;
        if (version && version !== catalogVersion) {
          catalogMap.set(name, version);
        }
      }
    }
  };

  updateDeps(pkg.dependencies);
  updateDeps(pkg.devDependencies);

  if (updated) {
    await Bun.write(packagePath, JSON.stringify(pkg, null, 2));
    console.log(`Updated ${packagePath} to use catalog references.`);
  }
};

const updateRootCatalog = async (catalogMap: Map<string, string>): Promise<void> => {
  const rootPackage: BunPackageJson = await Bun.file(rootPackagePath).json();
  const newCatalog: Record<string, string> = {};

  for (const [name, version] of catalogMap.entries()) {
    newCatalog[name] = version;
  }

  rootPackage.workspaces = rootPackage.workspaces || [];
  rootPackage.catalog = newCatalog;

  await Bun.write(rootPackagePath, JSON.stringify(rootPackage, null, 2));
  console.log('Updated root catalog in package.json.');
};

const runInstall = async (): Promise<void> => {
  console.log('Running bun install from root...');
  await Bun.spawn(['bun', 'install'], { cwd: process.cwd(), stdout: 'inherit' }).exited;
};

const runUpdate = async (args: string[]): Promise<void> => {
  const latest = args.includes('--latest');
  const yes = args.includes('-y') || args.includes('--yes');
  const force = args.includes('--force');
  const catalogMap = await getCatalogPackages();
  const pinnedEntries = force ? [] : await collectAllPinnedEntries();

  const catalogNotes: string[] = [];
  const policy = await readReleaseAgePolicy(process.cwd());
  const catalogUpdates = await planCatalogUpdates(
    Object.fromEntries(catalogMap),
    latest,
    force,
    makeCatalogResolver(policy, catalogNotes),
  );

  const report = await showOutdatedReport(
    latest,
    pinnedEntries,
    force,
    catalogUpdates.length > 0,
    new Set(catalogMap.keys()),
  );
  printCatalogUpdates(catalogUpdates);
  for (const note of catalogNotes) console.log(note);

  const updateCount = report.actionable + catalogUpdates.length;
  if (updateCount === 0) {
    if (report.pinnedPending > 0) {
      const n = report.pinnedPending;
      console.log(
        `\nNothing to update — ${n} pinned package${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} a newer version. Pass --force to include ${n === 1 ? 'it' : 'them'}.`,
      );
    }
    process.exit(0);
  }

  const confirmed = yes || (await confirmUpdate(updateCount));
  if (!confirmed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('');
  await runUpdates(latest);
  await catalogifyWorkspaceDependencies(frontendPackagePath, catalogMap);
  await catalogifyWorkspaceDependencies(serverPackagePath, catalogMap);
  for (const { name, to } of catalogUpdates) catalogMap.set(name, to);
  await updateRootCatalog(catalogMap);
  await restorePinnedEntries(pinnedEntries);
  await runInstall();
};

export { runUpdate as run };
