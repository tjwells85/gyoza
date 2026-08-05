import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';

/** Root package.json with Bun's top-level `catalog` field. Named `catalogs` are out of scope. */
export type BunPackageJson = PackageJson & { catalog?: Record<string, string> };

export type DependencySection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

export const DEPENDENCY_SECTIONS: DependencySection[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

export interface Workspace {
  /** Workspace name as written in the root `workspaces` array, e.g. 'server'. */
  name: string;
  /** Absolute path to the workspace's package.json. */
  packagePath: string;
}

export const rootPackagePath = (cwd: string = process.cwd()): string => join(cwd, 'package.json');

export const readPackageJson = <T extends PackageJson = BunPackageJson>(path: string): T => {
  if (!existsSync(path)) throw new Error(`${path} not found.`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};

export const writePackageJson = (path: string, pkg: PackageJson): void => {
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
};

/**
 * Expand the root `workspaces` array into concrete workspaces that have a package.json.
 * Literal entries pass through; glob entries (containing `*`) are expanded via Bun.Glob.
 */
export const getWorkspaces = (root: BunPackageJson, cwd: string = process.cwd()): Workspace[] => {
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
  const names: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      const glob = new Bun.Glob(pattern);
      for (const match of glob.scanSync({ cwd, onlyFiles: false })) {
        if (!names.includes(match)) names.push(match);
      }
    } else if (!names.includes(pattern)) {
      names.push(pattern);
    }
  }

  return names
    .map((name) => ({ name, packagePath: join(cwd, name, 'package.json') }))
    .filter((w) => existsSync(w.packagePath));
};

export const getCatalog = (root: BunPackageJson): Record<string, string> => root.catalog ?? {};

/**
 * Upsert a catalog entry. New keys are appended so the existing catalog order is
 * never re-sorted — a sort would turn the first run into one large noisy diff.
 */
export const setCatalogEntry = (root: BunPackageJson, name: string, version: string): void => {
  root.catalog = { ...(root.catalog ?? {}), [name]: version };
};

export const deleteCatalogEntry = (root: BunPackageJson, name: string): void => {
  if (!root.catalog) return;
  delete root.catalog[name];
  if (Object.keys(root.catalog).length === 0) delete root.catalog;
};

/** Which dependency section, if any, a workspace declares this package in. */
export const findDependencySection = (pkg: PackageJson, name: string): DependencySection | undefined =>
  DEPENDENCY_SECTIONS.find((section) => pkg[section]?.[name] !== undefined);

/** Workspace names that reference `name` via the `catalog:` protocol. */
export const findCatalogConsumers = (workspaces: Workspace[], name: string): string[] => {
  const consumers: string[] = [];

  for (const workspace of workspaces) {
    const pkg = readPackageJson<PackageJson>(workspace.packagePath);
    const section = findDependencySection(pkg, name);
    if (section && pkg[section]?.[name] === 'catalog:') consumers.push(workspace.name);
  }

  return consumers;
};
