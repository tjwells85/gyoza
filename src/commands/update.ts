import { $ } from 'bun';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
import type { CommandFlag } from '../gyoza.ts';

export const description = 'Interactive dependency updater';

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

type OutdatedPackage = {
  name: string;
  current: string;
  update: string;
  latest: string;
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '');

const parseOutdatedTable = (text: string): OutdatedPackage[] => {
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
      packages.push({ name: cells[0], current: cells[1], update: cells[2], latest: cells[3] });
    }
  }

  return packages;
};

const getWorkspaceOutdated = async (cwd: string): Promise<OutdatedPackage[]> => {
  const text = await $`bun outdated`.cwd(cwd).nothrow().text();
  return parseOutdatedTable(text);
};

const printWorkspaceOutdated = (label: string, updatable: OutdatedPackage[], useLatest: boolean): void => {
  if (updatable.length === 0) return;

  console.log(`\nWorkspace: ${label}`);

  const nameWidth = Math.max(10, ...updatable.map(p => p.name.length));
  const currentWidth = Math.max(9, ...updatable.map(p => p.current.length));
  const newWidth = Math.max(11, ...updatable.map(p => (useLatest ? p.latest : p.update).length));
  const totalWidth = nameWidth + currentWidth + newWidth + 6;

  console.log('─'.repeat(totalWidth));
  console.log(`${'Package'.padEnd(nameWidth)}  ${'Current'.padEnd(currentWidth)}  New Version`);
  console.log('─'.repeat(totalWidth));

  for (const pkg of updatable) {
    const newVersion = useLatest ? pkg.latest : pkg.update;
    console.log(`${pkg.name.padEnd(nameWidth)}  ${pkg.current.padEnd(currentWidth)}  ${newVersion}`);
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

const showOutdatedReport = async (
  useLatest: boolean,
  pinnedEntries: PinnedEntry[],
  force: boolean,
): Promise<number> => {
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
      const updatable = all.filter(p => (useLatest ? p.latest : p.update) !== p.current);
      return { label: w.label, all, updatable };
    }),
  );

  if (!force && pinnedEntries.length > 0) {
    const latestByName = new Map<string, string>();
    for (const { all } of results) {
      for (const pkg of all) {
        if (!latestByName.has(pkg.name)) latestByName.set(pkg.name, pkg.latest);
      }
    }
    printPinnedNotice(pinnedEntries, latestByName);
  }

  const total = results.reduce((sum, r) => sum + r.updatable.length, 0);

  if (total === 0) {
    console.log('All packages are up to date.\n');
    return 0;
  }

  for (const { label, updatable } of results) {
    printWorkspaceOutdated(label, updatable, useLatest);
  }

  console.log('');
  return total;
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

  const updateCount = await showOutdatedReport(latest, pinnedEntries, force);
  if (updateCount === 0) process.exit(0);

  const confirmed = yes || (await confirmUpdate(updateCount));
  if (!confirmed) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('');
  await runUpdates(latest);
  await catalogifyWorkspaceDependencies(frontendPackagePath, catalogMap);
  await catalogifyWorkspaceDependencies(serverPackagePath, catalogMap);
  await updateRootCatalog(catalogMap);
  await restorePinnedEntries(pinnedEntries);
  await runInstall();
};

export { runUpdate as run };
