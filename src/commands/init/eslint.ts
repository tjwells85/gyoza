import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandFlag } from '../../gyoza.ts';

export const description = 'Migrate eslint.config.mts files to .mjs in all workspaces';

export const flags: CommandFlag[] = [
  { flag: '--dry', description: 'Preview changes in eslint-migration.md without modifying files' },
];

const SEARCH_DIRS = ['.', 'frontend', 'server', 'shared'] as const;
const JSDOC = `/** @type {import('eslint').Linter.Config[]} */`;
const DRY_RUN_FILE = 'eslint-migration.md';

function transform(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];

  for (const rawLine of lines) {
    let line = rawLine;

    // Remove standalone @ts-* directive lines
    if (/^\s*\/\/ @ts-\S+/.test(line)) continue;

    // Remove inline trailing @ts-* comments
    line = line.replace(/ \/\/ @ts-\S+.*$/, '');

    // Inject JSDoc before defineConfig( if not already decorated
    if (line.includes('defineConfig(')) {
      const prevNonBlank = [...out].reverse().find((l) => l.trim() !== '');
      if (prevNonBlank !== JSDOC) {
        out.push(JSDOC);
      }
    }

    out.push(line);
  }

  // Collapse consecutive blank lines to at most one
  return out
    .reduce<string[]>((acc, line) => {
      if (line.trim() === '' && acc.at(-1)?.trim() === '') return acc;
      acc.push(line);
      return acc;
    }, [])
    .join('\n');
}

function dirLabel(dir: string): string {
  return dir === '.' ? './' : `${dir}/`;
}

export const run = async (args: string[]): Promise<void> => {
  const dry = args.includes('--dry');
  const cwd = process.cwd();

  if (dry) {
    const sections: string[] = ['# ESLint Migration Preview\n'];

    for (const dir of SEARCH_DIRS) {
      const mtsPath = join(cwd, dir, 'eslint.config.mts');
      sections.push(`## \`${dirLabel(dir)}\`\n`);

      if (!existsSync(mtsPath)) {
        sections.push('`eslint.config.mts` not found\n');
      } else {
        const transformed = transform(readFileSync(mtsPath, 'utf8'));
        if (existsSync(join(cwd, dir, 'eslint.config.mjs'))) {
          sections.push('> Note: `eslint.config.mjs` already exists — would be skipped in normal mode.\n');
        }
        sections.push('```js\n' + transformed + '\n```\n');
      }
    }

    writeFileSync(join(cwd, DRY_RUN_FILE), sections.join('\n'), 'utf8');
    console.log(`  ✓  Wrote ${DRY_RUN_FILE}`);
    return;
  }

  // Normal mode
  let migrated = 0;
  let skipped = 0;

  for (const dir of SEARCH_DIRS) {
    const mtsPath = join(cwd, dir, 'eslint.config.mts');
    const mjsPath = join(cwd, dir, 'eslint.config.mjs');
    const label = dirLabel(dir);

    if (!existsSync(mtsPath)) continue;

    if (existsSync(mjsPath)) {
      console.log(`  ⚠  ${label}eslint.config.mjs already exists — skipping ${label}eslint.config.mts`);
      skipped++;
      continue;
    }

    const transformed = transform(readFileSync(mtsPath, 'utf8'));
    writeFileSync(mjsPath, transformed, 'utf8');
    unlinkSync(mtsPath);
    console.log(`  ✓  ${label}eslint.config.mts → eslint.config.mjs`);
    migrated++;
  }

  if (migrated === 0 && skipped === 0) {
    console.log('  No eslint.config.mts files found.');
  }

  const mdPath = join(cwd, DRY_RUN_FILE);
  if (existsSync(mdPath)) {
    const answer = prompt(`\n  ${DRY_RUN_FILE} found. Remove it? [Y/n] `);
    if (answer === null || answer.trim() === '' || answer.trim().toLowerCase() === 'y') {
      unlinkSync(mdPath);
      console.log(`  ✓  Removed ${DRY_RUN_FILE}`);
    }
  }
};
