import { rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildContext {
  projectRoot: string;
  buildDir: string;
}

export interface BuildStep {
  name: string;
  /** 'pre' runs after clean, before frontend/server build. 'post' runs after assembly. Defaults to 'post'. */
  phase?: 'pre' | 'post';
  run(ctx: BuildContext): Promise<void>;
}

const runCommand = async (command: string, args: string[], description: string, cwd: string): Promise<void> => {
  console.log(`\n🔨 ${description}...`);

  const proc = Bun.spawn([command, ...args], { stdout: 'inherit', stderr: 'inherit', cwd });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${exitCode}`);
  }
};

const loadUserSteps = async (projectRoot: string): Promise<BuildStep[]> => {
  const configPath = join(projectRoot, 'gyoza.config.ts');
  if (!existsSync(configPath)) return [];

  try {
    const config = await import(configPath);
    return Array.isArray(config.buildSteps) ? (config.buildSteps as BuildStep[]) : [];
  } catch (err) {
    console.warn(`  ⚠ Failed to load gyoza.config.ts: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
};

const cleanBuildDir = async (buildDir: string): Promise<void> => {
  console.log('\n🧹 Cleaning build directory...');

  if (existsSync(buildDir)) {
    await rm(buildDir, { recursive: true, force: true });
    console.log('  ✓ Removed existing build directory');
  }

  await mkdir(buildDir, { recursive: true });
  await mkdir(join(buildDir, 'client'), { recursive: true });
  console.log('  ✓ Created fresh build directory structure');
};

const buildFrontend = async (projectRoot: string): Promise<void> => {
  await runCommand('bun', ['run', '--filter=frontend', '--elide-lines=0', 'build'], 'Building frontend', projectRoot);

  if (!existsSync(join(projectRoot, 'frontend/dist'))) {
    throw new Error('Frontend dist not found after build. Expected at: frontend/dist');
  }
};

const buildServer = async (projectRoot: string, buildDir: string): Promise<void> => {
  console.log('\n🔨 Building server...');

  await Bun.build({
    entrypoints: [join(projectRoot, 'server/server.ts')],
    target: 'bun',
    outdir: buildDir,
    sourcemap: 'external',
    env: 'inline',
  });

  console.log('  ✓ Server bundled successfully');
};

const assembleDist = async (projectRoot: string, buildDir: string): Promise<void> => {
  console.log('\n📦 Assembling distribution...');

  await cp(join(projectRoot, 'frontend/dist'), join(buildDir, 'client'), { recursive: true });
  console.log('  ✓ Copied frontend to build/client');

  const serverEnv = join(projectRoot, 'server/.env');
  if (existsSync(serverEnv)) {
    await cp(serverEnv, join(buildDir, '.env'));
    console.log('  ✓ Copied server/.env to build/.env');
  } else {
    console.warn('  ⚠ server/.env not found, skipping');
  }
};

const runBuild = async (_args: string[]): Promise<void> => {
  const startTime = performance.now();
  const projectRoot = process.cwd();
  const buildDir = join(projectRoot, 'build');
  const ctx: BuildContext = { projectRoot, buildDir };

  console.log('🚀 Starting production build...');
  console.log(`📁 Project root: ${projectRoot}`);

  try {
    const userSteps = await loadUserSteps(projectRoot);
    const preSteps = userSteps.filter(s => s.phase === 'pre');
    const postSteps = userSteps.filter(s => s.phase !== 'pre');

    await cleanBuildDir(buildDir);

    for (const step of preSteps) {
      console.log(`\n🔧 ${step.name}...`);
      await step.run(ctx);
    }

    await buildFrontend(projectRoot);
    await buildServer(projectRoot, buildDir);
    await assembleDist(projectRoot, buildDir);

    for (const step of postSteps) {
      console.log(`\n🔧 ${step.name}...`);
      await step.run(ctx);
    }

    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Build completed successfully in ${duration}s`);
    console.log(`📦 Distribution ready at: ${buildDir}`);
  } catch (error) {
    console.error('\n❌ Build failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

export const description = 'Build the monorepo for production';
export { runBuild as run };
