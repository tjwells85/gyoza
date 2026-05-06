import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILENAME = 'gyoza.config.ts';

const TEMPLATE = `import type { BuildStep } from 'gyoza';

export const buildSteps: BuildStep[] = [
  {
    name: 'Example post-build step',
    phase: 'post',
    run: async ({ projectRoot, buildDir }) => {
      console.log(\`Build finished. Root: \${projectRoot}, Output: \${buildDir}\`);
    },
  },
];
`;

const runInitConfig = async (_args: string[]): Promise<void> => {
  const dest = join(process.cwd(), CONFIG_FILENAME);

  if (existsSync(dest)) {
    console.error(`${CONFIG_FILENAME} already exists. Remove it first if you want to regenerate.`);
    process.exit(1);
  }

  writeFileSync(dest, TEMPLATE);
  console.log(`✓ Created ${CONFIG_FILENAME}`);
  console.log('  Edit buildSteps to add your custom build steps.');
};

export const description = `Scaffold a ${CONFIG_FILENAME} with a placeholder build step`;
export { runInitConfig as run };
