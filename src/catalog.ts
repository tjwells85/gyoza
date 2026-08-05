import { deleteCatalogEntry, DEPENDENCY_SECTIONS, readPackageJson, rootPackagePath, setCatalogEntry, writePackageJson } from './workspaces.ts';
import type { DependencySection, Workspace } from './workspaces.ts';
import type { PackageJson } from 'type-fest';

export interface CatalogArgs {
  /** Workspace names given to --catalog. */
  targets: string[];
  /** Positional package specs, e.g. ['date-fns', 'react@next']. */
  packages: string[];
  section: DependencySection;
  exact: boolean;
  dry: boolean;
  yes: boolean;
}

export type CatalogChange =
  | { kind: 'add'; name: string; to: string }
  | { kind: 'update'; name: string; from: string; to: string }
  | { kind: 'remove'; name: string; from: string };

export interface WorkspaceChange {
  workspace: string;
  packagePath: string;
  name: string;
  /** Target section for an upsert; the section it was found in for a removal. */
  section: DependencySection;
  kind: 'add' | 'remove';
  /** Previous value in the workspace package.json, when it already declared the package. */
  from?: string;
}

const SECTION_FLAGS: Record<string, DependencySection> = {
  '-d': 'devDependencies',
  '-D': 'devDependencies',
  '--dev': 'devDependencies',
  '--development': 'devDependencies',
  '--peer': 'peerDependencies',
  '--optional': 'optionalDependencies',
};

const BOOLEAN_FLAGS = new Set(['--dry', '-y', '--yes', '-E', '--exact', ...Object.keys(SECTION_FLAGS)]);

export const hasCatalogFlag = (args: string[]): boolean =>
  args.some((arg) => arg === '--catalog' || arg.startsWith('--catalog='));

/** Parse catalog-mode argv. Throws with a user-facing message on bad input. */
export const parseCatalogArgs = (args: string[]): CatalogArgs => {
  const targets: string[] = [];
  const packages: string[] = [];
  let section: DependencySection = 'dependencies';
  let exact = false;
  let dry = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--catalog' || arg.startsWith('--catalog=')) {
      const raw = arg.startsWith('--catalog=') ? arg.slice('--catalog='.length) : args[++i];
      if (!raw || raw.startsWith('-')) throw new Error('--catalog requires a comma-separated list of workspaces, e.g. --catalog server,frontend');
      for (const name of raw.split(',').map((n) => n.trim()).filter(Boolean)) {
        if (!targets.includes(name)) targets.push(name);
      }
      continue;
    }

    if (!arg.startsWith('-')) {
      packages.push(arg);
      continue;
    }

    if (!BOOLEAN_FLAGS.has(arg)) {
      throw new Error(
        `"${arg}" is not supported with --catalog.\n` +
          '  Supported: --dry, -y/--yes, -E/--exact, -d/--dev, --peer, --optional\n' +
          '  gyoza writes package.json directly in catalog mode, so bun flags like -a/--analyze and --only-missing cannot be honored.',
      );
    }

    const mapped = SECTION_FLAGS[arg];
    if (mapped) section = mapped;
    else if (arg === '-E' || arg === '--exact') exact = true;
    else if (arg === '--dry') dry = true;
    else yes = true;
  }

  if (targets.length === 0) throw new Error('--catalog requires at least one workspace name.');
  if (packages.length === 0) throw new Error('No packages given. Usage: gyoza add --catalog <workspaces> <package>...');

  return { targets, packages, section, exact, dry, yes };
};

/** Map --catalog target names onto real workspaces. Throws listing valid names on a miss. */
export const resolveTargets = (targets: string[], workspaces: Workspace[]): Workspace[] =>
  targets.map((name) => {
    const match = workspaces.find((w) => w.name === name);
    if (!match) {
      const valid = workspaces.map((w) => w.name).join(', ') || '(none found)';
      throw new Error(`Unknown workspace "${name}". Valid workspaces: ${valid}`);
    }
    return match;
  });

export const applyChanges = (cwd: string, catalogChanges: CatalogChange[], workspaceChanges: WorkspaceChange[]): void => {
  if (catalogChanges.length > 0) {
    const path = rootPackagePath(cwd);
    const root = readPackageJson(path);

    for (const change of catalogChanges) {
      if (change.kind === 'remove') deleteCatalogEntry(root, change.name);
      else setCatalogEntry(root, change.name, change.to);
    }

    writePackageJson(path, root);
  }

  const byPath = new Map<string, WorkspaceChange[]>();
  for (const change of workspaceChanges) {
    const list = byPath.get(change.packagePath) ?? [];
    list.push(change);
    byPath.set(change.packagePath, list);
  }

  for (const [path, changes] of byPath) {
    const pkg = readPackageJson<PackageJson>(path);

    for (const change of changes) {
      // Drop it from every section first so an upsert can't leave a duplicate behind.
      for (const existing of DEPENDENCY_SECTIONS) {
        const deps = pkg[existing];
        if (deps) delete deps[change.name];
      }

      if (change.kind === 'add') {
        const deps = (pkg[change.section] ?? {}) as Record<string, string>;
        deps[change.name] = 'catalog:';
        pkg[change.section] = deps;
      }
    }

    for (const section of DEPENDENCY_SECTIONS) {
      if (pkg[section] && Object.keys(pkg[section]).length === 0) delete pkg[section];
    }

    writePackageJson(path, pkg);
  }
};

/** Hand the whole argv to bun untouched and exit with its code. */
export const passthrough = async (command: 'add' | 'remove', args: string[]): Promise<never> => {
  const proc = Bun.spawn(['bun', command, ...args], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(await proc.exited);
};

export const runInstall = async (cwd: string): Promise<void> => {
  console.log('\nRunning bun install...');
  await Bun.spawn(['bun', 'install'], { cwd, stdout: 'inherit', stderr: 'inherit' }).exited;
};
