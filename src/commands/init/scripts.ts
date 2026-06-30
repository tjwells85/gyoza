import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
import type { CommandFlag } from '../../gyoza.ts';

export const description = 'Upsert gyoza scripts in package.json and remove legacy script files';

export const flags: CommandFlag[] = [
  { flag: '--dry', description: 'Preview all changes without modifying any files' },
];

const TARGET_SCRIPTS: [string, string][] = [
  ['build', 'gyoza build'],
  ['update:all', 'gyoza update'],
  ['update:latest', 'gyoza update --latest'],
  ['generate:env', 'gyoza generate env'],
];

const LEGACY_SCRIPT_FILES = ['build.ts', 'prepare.ts', 'update.ts'];

type ScriptChange =
  | { kind: 'add'; key: string; value: string }
  | { kind: 'replace'; key: string; oldValue: string; value: string }
  | { kind: 'remove'; key: string; oldValue: string };

export const run = async (args: string[]): Promise<void> => {
  const dry = args.includes('--dry');
  const cwd = process.cwd();

  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error('  ✗  package.json not found');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;

  // Collect script changes
  const changes: ScriptChange[] = [];

  // 1. Legacy 'env' script removals (process before upserts so we don't
  //    accidentally remove a target key like 'generate:env' we're about to add)
  const targetKeys = new Set(TARGET_SCRIPTS.map(([k]) => k));
  for (const key of Object.keys(scripts)) {
    if (
      key.toLowerCase().includes('env') &&
      !targetKeys.has(key) &&
      !scripts[key]?.includes('gyoza')
    ) {
      changes.push({ kind: 'remove', key, oldValue: scripts[key] ?? '' });
    }
  }

  // 2. Target script upserts
  for (const [key, value] of TARGET_SCRIPTS) {
    const existing = scripts[key];
    if (existing?.includes('gyoza')) continue; // customised — skip
    if (existing !== undefined) {
      changes.push({ kind: 'replace', key, oldValue: existing, value });
    } else {
      changes.push({ kind: 'add', key, value });
    }
  }

  // 3. Script file deletions
  const scriptsDir = join(cwd, 'scripts');
  const filesToDelete: string[] = [];
  if (existsSync(scriptsDir)) {
    for (const filename of LEGACY_SCRIPT_FILES) {
      if (existsSync(join(scriptsDir, filename))) {
        filesToDelete.push(filename);
      }
    }
  }

  if (dry) {
    if (changes.length === 0 && filesToDelete.length === 0) {
      console.log('  No changes needed.');
      return;
    }

    if (changes.length > 0) {
      console.log('Scripts (package.json):');
      for (const change of changes) {
        if (change.kind === 'add') {
          console.log(`  "${change.key}": (none) -> "${change.key}": "${change.value}"`);
        } else if (change.kind === 'replace') {
          console.log(`  "${change.key}": "${change.oldValue}" -> "${change.key}": "${change.value}"`);
        } else {
          console.log(`  "${change.key}": "${change.oldValue}" -> REMOVED`);
        }
      }
    }

    if (filesToDelete.length > 0) {
      if (changes.length > 0) console.log('');
      console.log('Script files:');
      for (const filename of filesToDelete) {
        console.log(`  scripts/${filename} -> DELETED`);
      }

      const remainingAfterDelete =
        readdirSync(scriptsDir).filter((f) => !filesToDelete.includes(f));
      if (remainingAfterDelete.length === 0) {
        console.log('  scripts/ -> DELETED (empty after removals)');
      }
    }

    return;
  }

  // Normal mode — apply changes
  if (changes.length === 0 && filesToDelete.length === 0) {
    console.log('  No changes needed.');
    return;
  }

  const updatedScripts = { ...scripts };

  for (const change of changes) {
    if (change.kind === 'add' || change.kind === 'replace') {
      updatedScripts[change.key] = change.value;
    } else {
      delete updatedScripts[change.key];
    }
  }

  pkg.scripts = updatedScripts;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  for (const change of changes) {
    if (change.kind === 'add') {
      console.log(`  ✓  Added "${change.key}": "${change.value}"`);
    } else if (change.kind === 'replace') {
      console.log(`  ✓  Updated "${change.key}": "${change.oldValue}" -> "${change.value}"`);
    } else {
      console.log(`  ✓  Removed "${change.key}"`);
    }
  }

  for (const filename of filesToDelete) {
    rmSync(join(scriptsDir, filename));
    console.log(`  ✓  Deleted scripts/${filename}`);
  }

  if (filesToDelete.length > 0 && readdirSync(scriptsDir).length === 0) {
    rmSync(scriptsDir, { recursive: true });
    console.log('  ✓  Deleted scripts/ (empty)');
  }
};
