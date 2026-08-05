import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { PackageJson } from 'type-fest';
import { findDependencySection, getWorkspaces, readPackageJson, rootPackagePath } from '../workspaces.ts';

export const description = 'Update gyoza itself from its git remote';

interface Declaration {
  /** Directory to run `bun update` from — whichever package.json declares gyoza. */
  dir: string;
  /** The dependency spec, e.g. 'github:tjwells85/gyoza'. */
  spec: string;
  /**
   * Explicit ref from the spec, if any. A branch (`#main`) still tracks and moves;
   * a tag or commit does not. The two are indistinguishable without querying the
   * remote, so this is reported rather than used to block.
   */
  ref?: string;
}

/**
 * Find the package.json that declares gyoza — root first, then each workspace.
 * `bun update` has to run from the directory that owns the dependency.
 */
export const findDeclaration = (cwd: string): Declaration | undefined => {
  const root = readPackageJson(rootPackagePath(cwd));
  const candidates = [{ dir: cwd, pkg: root as PackageJson }];

  for (const workspace of getWorkspaces(root, cwd)) {
    candidates.push({ dir: dirname(workspace.packagePath), pkg: readPackageJson<PackageJson>(workspace.packagePath) });
  }

  for (const { dir, pkg } of candidates) {
    const section = findDependencySection(pkg, 'gyoza');
    const spec = section ? pkg[section]?.gyoza : undefined;
    if (spec === undefined) continue;

    const hash = spec.indexOf('#');
    return hash === -1 ? { dir, spec } : { dir, spec, ref: spec.slice(hash + 1) };
  }

  return undefined;
};

/**
 * Compare two `x.y.z[-prerelease]` versions. Negative when `a` is older.
 * A prerelease sorts before the release sharing its version core.
 */
export const compareVersions = (a: string, b: string): number => {
  const core = (v: string): number[] => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [left, right] = [core(a), core(b)];

  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  const [leftPre, rightPre] = [a.includes('-'), b.includes('-')];
  if (leftPre === rightPre) return 0;
  return leftPre ? -1 : 1;
};

/**
 * Changelog entries newer than `fromVersion`. The file is newest-first, so this
 * collects sections from the top and stops at the version we were already on.
 */
export const changelogSince = (markdown: string, fromVersion: string): string => {
  const collected: string[] = [];
  let current: string[] | undefined;

  for (const line of markdown.split('\n')) {
    const heading = /^## \[?([^\]\s]+)\]?/.exec(line);

    if (heading) {
      if (heading[1] === fromVersion) break;
      if (current) collected.push(current.join('\n').trimEnd());
      current = [line];
      continue;
    }

    if (current && line.trim() !== '---') current.push(line);
  }

  if (current) collected.push(current.join('\n').trimEnd());
  return collected.join('\n\n').trim();
};

/**
 * The installed gyoza package root. This is the one command that deliberately
 * resolves against its own install location rather than process.cwd() — it is
 * updating itself, not the project.
 */
const gyozaPackageDir = (): string => resolve(import.meta.dir, '..', '..');

const readGyozaVersion = (dir: string): string | undefined => {
  const path = join(dir, 'package.json');
  if (!existsSync(path)) return undefined;
  return readPackageJson<PackageJson>(path).version;
};

export const run = async (_args: string[]): Promise<void> => {
  const cwd = process.cwd();

  try {
    const declaration = findDeclaration(cwd);

    if (!declaration) {
      throw new Error(
        'gyoza is not a dependency of this project.\n' +
          '  Add it with: bun add -d github:tjwells85/gyoza\n' +
          '  (running via bunx installs a throwaway copy, which has nothing to update)',
      );
    }

    const packageDir = gyozaPackageDir();

    if (!packageDir.split(sep).includes('node_modules')) {
      throw new Error(`gyoza is running from a source checkout (${packageDir}), not an installed dependency. Nothing to update.`);
    }

    const before = readGyozaVersion(packageDir);
    if (before === undefined) throw new Error(`Could not read the installed gyoza version at ${packageDir}.`);

    console.log(`Current: gyoza ${before}`);
    if (declaration.ref) {
      console.log(`  ⚠ The spec targets "${declaration.ref}" — a branch will move, a tag or commit will not.`);
    }
    console.log(`Updating from ${declaration.spec}...\n`);

    const exitCode = await Bun.spawn(['bun', 'update', 'gyoza'], {
      cwd: declaration.dir,
      stdout: 'inherit',
      stderr: 'inherit',
    }).exited;

    if (exitCode !== 0) throw new Error(`bun update gyoza exited with code ${exitCode}.`);

    const after = readGyozaVersion(packageDir);

    if (after === undefined) {
      console.log('\n  ⚠ Updated, but the new version could not be read.');
      return;
    }

    if (after === before) {
      console.log(`\n  ✓  Already up to date (gyoza ${after}).`);
      if (declaration.ref) {
        console.log(`     If "${declaration.ref}" is a tag or commit, bun update cannot move it — edit the spec in ${declaration.dir}/package.json.`);
      }
      return;
    }

    const forwards = compareVersions(after, before) > 0;

    if (forwards) {
      console.log(`\n  ✓  Updated gyoza ${before} -> ${after}`);

      // Only meaningful moving forwards — the changelog of an older release
      // cannot describe what changed since a newer one.
      const changelogPath = join(packageDir, 'changelog.md');
      if (existsSync(changelogPath)) {
        const entries = changelogSince(await Bun.file(changelogPath).text(), before);
        if (entries) console.log(`\nChanges in this upgrade:\n\n${entries}`);
      }
    } else {
      console.log(`\n  ✓  Downgraded gyoza ${before} -> ${after}`);
      if (declaration.ref) console.log(`     The spec targets "${declaration.ref}", which resolves to ${after}.`);
    }

    console.log('\nThe new version applies to your next gyoza invocation.');
  } catch (err) {
    console.error(`  ✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};
