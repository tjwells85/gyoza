import { relative } from 'node:path';
import type { PackageJson } from 'type-fest';
import { applyChanges, hasCatalogFlag, parseCatalogArgs, passthrough, resolveTargets, runInstall } from '../catalog.ts';
import type { CatalogArgs, CatalogChange, WorkspaceChange } from '../catalog.ts';
import { readReleaseAgePolicy } from '../bunfig.ts';
import type { CommandFlag } from '../gyoza.ts';
import { confirm } from '../prompt.ts';
import { parsePackageSpec, resolveCatalogVersion } from '../version.ts';
import type { PackageSpec } from '../version.ts';
import { findCatalogConsumers, findDependencySection, getCatalog, getWorkspaces, readPackageJson, rootPackagePath } from '../workspaces.ts';
import type { Workspace } from '../workspaces.ts';

export const description = 'Add a dependency — passes through to bun add unless --catalog is given';

export const flags: CommandFlag[] = [
  { flag: '--catalog <ws,...>', description: 'Add to the root catalog and reference it from these workspaces' },
  { flag: '--dry', description: 'Preview the changes without modifying any files' },
  { flag: '-y, --yes', description: 'Skip confirmation prompts' },
  { flag: '-E, --exact', description: 'Write the resolved version without a ^ range' },
  { flag: '-d, --dev', description: 'Add to devDependencies (also --peer, --optional)' },
];

/** `add` only ever writes to the catalog — it never prunes. */
type CatalogUpsert = Extract<CatalogChange, { kind: 'add' | 'update' }>;

export interface AddPlan {
  catalogChanges: CatalogUpsert[];
  workspaceChanges: WorkspaceChange[];
  /** Packages whose catalog entry is already correct — listed for the report only. */
  unchanged: { name: string; version: string }[];
  /** Packages skipped because the user declined a version bump. */
  skipped: string[];
}

/** Asked before changing a catalog version other workspaces already depend on. */
export type BumpConfirmer = (name: string, from: string, to: string, consumers: string[]) => Promise<boolean>;

/** Injectable so tests can build plans without hitting the registry. */
export type VersionResolver = (spec: PackageSpec, exact: boolean) => Promise<string>;

export const buildAddPlan = async (
  args: CatalogArgs,
  workspaces: Workspace[],
  targets: Workspace[],
  catalog: Record<string, string>,
  confirmBump: BumpConfirmer,
  resolve: VersionResolver,
): Promise<AddPlan> => {
  const plan: AddPlan = { catalogChanges: [], workspaceChanges: [], unchanged: [], skipped: [] };

  for (const input of args.packages) {
    const spec = parsePackageSpec(input);
    const existing = catalog[spec.name];

    if (existing !== undefined && !spec.spec) {
      // Extending an existing entry to another workspace must never bump the
      // version other workspaces are already pinned to.
      plan.unchanged.push({ name: spec.name, version: existing });
    } else {
      const resolved = await resolve(spec, args.exact);

      if (existing === undefined) {
        plan.catalogChanges.push({ kind: 'add', name: spec.name, to: resolved });
      } else if (existing === resolved) {
        plan.unchanged.push({ name: spec.name, version: existing });
      } else {
        const consumers = findCatalogConsumers(workspaces, spec.name);
        if (!(await confirmBump(spec.name, existing, resolved, consumers))) {
          plan.skipped.push(spec.name);
          continue;
        }
        plan.catalogChanges.push({ kind: 'update', name: spec.name, from: existing, to: resolved });
      }
    }

    for (const target of targets) {
      const pkg = readPackageJson<PackageJson>(target.packagePath);
      const section = findDependencySection(pkg, spec.name);
      const from = section ? pkg[section]?.[spec.name] : undefined;

      if (from === 'catalog:' && section === args.section) continue;

      plan.workspaceChanges.push({
        workspace: target.name,
        packagePath: target.packagePath,
        name: spec.name,
        section: args.section,
        kind: 'add',
        from,
      });
    }
  }

  return plan;
};

const printPlan = (cwd: string, plan: AddPlan): void => {
  const catalogLines = [
    ...plan.catalogChanges.map((change) =>
      change.kind === 'add'
        ? `  "${change.name}": (none) -> "${change.to}"`
        : `  "${change.name}": "${change.from}" -> "${change.to}"`,
    ),
    ...plan.unchanged.map((entry) => `  "${entry.name}": "${entry.version}" (unchanged)`),
  ];

  if (catalogLines.length > 0) {
    console.log('Catalog (package.json):');
    for (const line of catalogLines) console.log(line);
  }

  if (plan.workspaceChanges.length > 0) {
    if (catalogLines.length > 0) console.log('');
    console.log('Workspaces:');
    const width = Math.max(...plan.workspaceChanges.map((c) => relative(cwd, c.packagePath).length));
    for (const change of plan.workspaceChanges) {
      const path = relative(cwd, change.packagePath).padEnd(width);
      const from = change.from === undefined ? '(none)' : `"${change.from}"`;
      console.log(`  ${path}  "${change.name}": ${from} -> "catalog:" (${change.section})`);
    }
  }

  for (const name of plan.skipped) {
    console.log(`  ⚠ Skipped ${name} — catalog version left unchanged.`);
  }
};

export const run = async (args: string[]): Promise<void> => {
  if (!hasCatalogFlag(args)) await passthrough('add', args);

  const cwd = process.cwd();

  try {
    const parsed = parseCatalogArgs(args);
    const root = readPackageJson(rootPackagePath(cwd));
    const workspaces = getWorkspaces(root, cwd);
    const targets = resolveTargets(parsed.targets, workspaces);

    const notes: string[] = [];

    // bun refuses to install anything newer than minimumReleaseAge, so the
    // catalog must not name a version it would then reject.
    const policy = await readReleaseAgePolicy(cwd);
    const resolve: VersionResolver = (spec, exact) =>
      resolveCatalogVersion(spec, exact, policy, (note) => notes.push(`  · ${note}`));

    const confirmBump: BumpConfirmer = async (name, from, to, consumers) => {
      const affected = consumers.length > 0 ? consumers.join(', ') : '(no workspaces yet)';
      if (parsed.dry) {
        notes.push(`  · Would prompt before bumping "${name}" ${from} -> ${to} (affects ${affected})`);
        return true;
      }
      if (parsed.yes) return true;
      console.log(`\n"${name}" is already in the catalog at ${from}.`);
      console.log(`Changing it to ${to} affects: ${affected}`);
      return confirm('Update the catalog entry?', false);
    };

    const plan = await buildAddPlan(parsed, workspaces, targets, getCatalog(root), confirmBump, resolve);

    if (plan.catalogChanges.length === 0 && plan.workspaceChanges.length === 0) {
      console.log('  No changes needed.');
      return;
    }

    if (parsed.dry) {
      printPlan(cwd, plan);
      for (const note of notes) console.log(note);
      return;
    }

    applyChanges(cwd, plan.catalogChanges, plan.workspaceChanges);
    printPlan(cwd, plan);
    for (const note of notes) console.log(note);
    await runInstall(cwd);
  } catch (err) {
    console.error(`  ✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};
