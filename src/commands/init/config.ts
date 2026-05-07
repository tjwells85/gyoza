import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILENAME = 'gyoza.config.ts';

const NEW_TEMPLATE = `import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,
    pre: [],
    post: [
      {
        name: 'Example post-build step',
        run: async ({ projectRoot, buildDir }) => {
          console.log(\`Build finished. Root: \${projectRoot}, Output: \${buildDir}\`);
        },
      },
    ],
  },
} satisfies GyozaConfig;
`;

const isLegacyConfig = (source: string): boolean => /export\s+const\s+buildSteps/.test(source);

/**
 * Extracts the array literal assigned to `buildSteps` using bracket matching.
 * Skips string literals, template literals, and comments to avoid false bracket counts.
 */
const extractBuildStepsLiteral = (source: string): string | null => {
  const assignMatch = source.match(/export\s+const\s+buildSteps[^=]*=\s*/);
  if (!assignMatch || assignMatch.index === undefined) return null;

  const start = assignMatch.index + assignMatch[0].length;
  if (source[start] !== '[') return null;

  let i = start;
  let depth = 0;

  while (i < source.length) {
    const ch = source[i];

    // Line comment
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // String literals — skip until closing quote, respecting escapes
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }

    // Template literals — track ${} depth so inner } doesn't end the template
    if (ch === '`') {
      i++;
      let exprDepth = 0;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') { exprDepth++; i += 2; continue; }
        if (source[i] === '}' && exprDepth > 0) { exprDepth--; i++; continue; }
        if (source[i] === '`' && exprDepth === 0) { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }

    i++;
  }

  return null; // unbalanced — malformed source
};

const migrateLegacyConfig = (source: string): string | null => {
  const stepsLiteral = extractBuildStepsLiteral(source);
  if (stepsLiteral === null) return null;

  return `import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,
    pre: [],
    post: [],
    // migrated from buildSteps — move entries into pre/post and remove the phase field
    steps: ${stepsLiteral},
  },
} satisfies GyozaConfig;
`;
};

const runInitConfig = async (_args: string[]): Promise<void> => {
  const dest = join(process.cwd(), CONFIG_FILENAME);

  if (!existsSync(dest)) {
    writeFileSync(dest, NEW_TEMPLATE);
    console.log(`✓ Created ${CONFIG_FILENAME}`);
    console.log('  Edit build.pre / build.post to add your custom build steps.');
    return;
  }

  const source = readFileSync(dest, 'utf8');

  if (!isLegacyConfig(source)) {
    console.error(`${CONFIG_FILENAME} already exists. Remove it first if you want to regenerate.`);
    process.exit(1);
  }

  const migrated = migrateLegacyConfig(source);
  if (migrated === null) {
    console.error(`Could not parse buildSteps array in ${CONFIG_FILENAME} — migrate manually.`);
    process.exit(1);
  }

  writeFileSync(dest, migrated);
  console.log(`✓ Migrated ${CONFIG_FILENAME} to new format.`);
  console.log('  Steps moved into build.steps (deprecated). Move them into build.pre / build.post when ready.');
};

export const description = `Scaffold or migrate ${CONFIG_FILENAME}`;
export { runInitConfig as run };
