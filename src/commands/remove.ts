import { relative } from 'node:path';
import type { PackageJson } from 'type-fest';
import { applyChanges, hasCatalogFlag, parseCatalogArgs, passthrough, resolveTargets, runInstall } from '../catalog.ts';
import type { CatalogArgs, CatalogChange, WorkspaceChange } from '../catalog.ts';
import type { CommandFlag } from '../gyoza.ts';
import { confirm } from '../prompt.ts';
import { parsePackageSpec } from '../version.ts';
import { findCatalogConsumers, findDependencySection, getCatalog, getWorkspaces, readPackageJson, rootPackagePath } from '../workspaces.ts';
import type { Workspace } from '../workspaces.ts';

export const description = 'Remove a dependency — passes through to bun remove unless --catalog is given';

export const flags: CommandFlag[] = [
  { flag: '--catalog <ws,...>', description: 'Remove from these workspaces and prune the root catalog entry if orphaned' },
  { flag: '--dry', description: 'Preview the changes without modifying any files' },
  { flag: '-y, --yes', description: 'Skip confirmation prompts' },
];

export interface RemovePlan {
  catalogChanges: CatalogChange[];
  workspaceChanges: WorkspaceChange[];
  /** Packages not declared by any targeted workspace. */
  notFound: string[];
  /** Orphaned catalog entries the user chose to keep. */
  kept: string[];
}

/** Asked before deleting a catalog entry no workspace references anymore. */
export type PruneConfirmer = (name: string, version: string) => Promise<boolean>;

export const buildRemovePlan = async (
  args: CatalogArgs,
  workspaces: Workspace[],
  targets: Workspace[],
  catalog: Record<string, string>,
  confirmPrune: PruneConfirmer,
): Promise<RemovePlan> => {
  const plan: RemovePlan = { catalogChanges: [], workspaceChanges: [], notFound: [], kept: [] };
  const targetNames = targets.map((t) => t.name);

  for (const input of args.packages) {
    const { name } = parsePackageSpec(input);
    let found = false;

    for (const target of targets) {
      const pkg = readPackageJson<PackageJson>(target.packagePath);
      const section = findDependencySection(pkg, name);
      if (!section) continue;

      found = true;
      plan.workspaceChanges.push({
        workspace: target.name,
        packagePath: target.packagePath,
        name,
        section,
        kind: 'remove',
        from: pkg[section]?.[name],
      });
    }

    if (!found) plan.notFound.push(name);

    const existing = catalog[name];
    if (existing === undefined) continue;

    const survivors = findCatalogConsumers(workspaces, name).filter((w) => !targetNames.includes(w));
    if (survivors.length > 0) continue;

    if (await confirmPrune(name, existing)) {
      plan.catalogChanges.push({ kind: 'remove', name, from: existing });
    } else {
      plan.kept.push(name);
    }
  }

  return plan;
};

const printPlan = (cwd: string, plan: RemovePlan): void => {
  if (plan.workspaceChanges.length > 0) {
    console.log('Workspaces:');
    const width = Math.max(...plan.workspaceChanges.map((c) => relative(cwd, c.packagePath).length));
    for (const change of plan.workspaceChanges) {
      const path = relative(cwd, change.packagePath).padEnd(width);
      console.log(`  ${path}  "${change.name}": "${change.from}" -> REMOVED (${change.section})`);
    }
  }

  if (plan.catalogChanges.length > 0) {
    if (plan.workspaceChanges.length > 0) console.log('');
    console.log('Catalog (package.json):');
    for (const change of plan.catalogChanges) {
      console.log(`  "${change.name}": "${change.kind === 'remove' ? change.from : change.to}" -> REMOVED (orphaned)`);
    }
  }

  for (const name of plan.kept) {
    console.log(`  · Kept catalog entry "${name}" — no workspace references it.`);
  }

  for (const name of plan.notFound) {
    console.log(`  ⚠ "${name}" is not declared by any targeted workspace.`);
  }
};

export const run = async (args: string[]): Promise<void> => {
  if (!hasCatalogFlag(args)) await passthrough('remove', args);

  const cwd = process.cwd();

  try {
    const parsed = parseCatalogArgs(args);
    const root = readPackageJson(rootPackagePath(cwd));
    const workspaces = getWorkspaces(root, cwd);
    const targets = resolveTargets(parsed.targets, workspaces);

    const notes: string[] = [];

    const confirmPrune: PruneConfirmer = async (name, version) => {
      if (parsed.dry) {
        notes.push(`  · Would prompt before pruning the orphaned catalog entry "${name}" (${version})`);
        return true;
      }
      if (parsed.yes) return true;
      console.log(`\nNo workspace references "${name}" (${version}) anymore.`);
      return confirm('Remove it from the root catalog?', true);
    };

    const plan = await buildRemovePlan(parsed, workspaces, targets, getCatalog(root), confirmPrune);

    if (plan.catalogChanges.length === 0 && plan.workspaceChanges.length === 0) {
      printPlan(cwd, plan);
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
    await runInstall(cwd);
  } catch (err) {
    console.error(`  ✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};
