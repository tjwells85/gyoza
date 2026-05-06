import { $ } from 'bun';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
import type { Command } from '../types.ts';

type BunPackageJson = PackageJson & { catalog: Record<string, string> };

const rootPackagePath = join(process.cwd(), 'package.json');
const frontendPackagePath = join(process.cwd(), 'frontend', 'package.json');
const serverPackagePath = join(process.cwd(), 'server', 'package.json');

const getCatalogPackages = async (): Promise<Map<string, string>> => {
  const catalogMap = new Map<string, string>();
  const rootPackage: BunPackageJson = await Bun.file(rootPackagePath).json();
  const catalog = rootPackage.catalog || {};

  for (const [pkg, version] of Object.entries(catalog)) {
    catalogMap.set(pkg, version);
  }

  return catalogMap;
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

const printWorkspaceOutdated = (
  label: string,
  updatable: OutdatedPackage[],
  pinned: OutdatedPackage[],
  useLatest: boolean,
): void => {
  if (updatable.length === 0 && pinned.length === 0) return;

  console.log(`\nWorkspace: ${label}`);

  if (updatable.length > 0) {
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
  }

  if (pinned.length > 0) {
    const nameWidth = Math.max(10, ...pinned.map(p => p.name.length));
    const currentWidth = Math.max(9, ...pinned.map(p => p.current.length));
    const latestWidth = Math.max(6, ...pinned.map(p => p.latest.length));
    const totalWidth = nameWidth + currentWidth + latestWidth + 6;

    console.log('\n  Pinned (skipped):');
    console.log('  ' + '─'.repeat(totalWidth));
    console.log(`  ${'Package'.padEnd(nameWidth)}  ${'Current'.padEnd(currentWidth)}  Latest`);
    console.log('  ' + '─'.repeat(totalWidth));

    for (const pkg of pinned) {
      console.log(`  ${pkg.name.padEnd(nameWidth)}  ${pkg.current.padEnd(currentWidth)}  ${pkg.latest}`);
    }
  }
};

const showOutdatedReport = async (useLatest: boolean): Promise<number> => {
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
      const pinned = all.filter(
        p => (useLatest ? p.latest : p.update) === p.current && p.latest !== p.current,
      );
      return { label: w.label, updatable, pinned };
    }),
  );

  const total = results.reduce((sum, r) => sum + r.updatable.length, 0);

  if (total === 0 && results.every(r => r.pinned.length === 0)) {
    console.log('All packages are up to date.\n');
    return 0;
  }

  for (const { label, updatable, pinned } of results) {
    printWorkspaceOutdated(label, updatable, pinned, useLatest);
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
  const catalogMap = await getCatalogPackages();

  const updateCount = await showOutdatedReport(latest);
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
  await runInstall();
};

export const updateCommand: Command = {
  name: 'update',
  description: 'Interactive dependency updater',
  flags: [
    { flag: '--latest', description: 'Update to latest versions (ignores semver range)' },
    { flag: '-y, --yes', description: 'Skip confirmation prompt' },
  ],
  run: runUpdate,
};
