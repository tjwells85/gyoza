import { rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { loadConfig, normalizeSteps, validateBuildConfig } from '../config.ts';
import type {
  BuildContext,
  BuildStep,
  BuildSteps,
  CheckAction,
  LintCheckLevel,
  NormalizedStep,
  StepResults,
  TypeCheckLevel,
} from '../config.ts';

const spawnCaptured = async (cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', cwd });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const runTypecheck = async (projectRoot: string, level: TypeCheckLevel): Promise<boolean> => {
  if (level === 'off') return true;

  console.log('\n🔍 Type checking...');
  const { stdout, stderr, exitCode } = await spawnCaptured(['bunx', 'tsc', '--noEmit'], projectRoot);

  if (exitCode === 0) {
    console.log('  ✓ No type errors');
    return true;
  }

  const output = stdout + stderr;
  const count = (output.match(/: error TS\d+:/g) ?? []).length;
  const summary = count > 0 ? `${count} error${count !== 1 ? 's' : ''}` : 'errors found';

  if (level === 'warn') {
    console.warn(`  ⚠ TypeScript: ${summary}`);
    return true;
  }

  console.error(`  ✗ TypeScript: ${summary}`);
  return false;
};

const normalizeLintLevel = (level: LintCheckLevel): { onError: CheckAction; onWarning: CheckAction } | 'off' => {
  if (level === 'off') return 'off';
  if (level === 'warn') return { onError: 'warn', onWarning: 'warn' };
  if (level === 'fail') return { onError: 'fail', onWarning: 'fail' };
  return level;
};

const runLint = async (projectRoot: string, level: LintCheckLevel): Promise<boolean> => {
  const resolved = normalizeLintLevel(level);
  if (resolved === 'off') return true;

  console.log('\n🔍 Linting...');
  const { stdout, exitCode } = await spawnCaptured(['bunx', 'eslint', '.', '--format', 'json'], projectRoot);

  if (exitCode === 0) {
    console.log('  ✓ No lint issues');
    return true;
  }

  let errors = 0;
  let warnings = 0;
  let parsed = false;

  try {
    const results = JSON.parse(stdout) as Array<{ errorCount: number; warningCount: number }>;
    for (const file of results) {
      errors += file.errorCount;
      warnings += file.warningCount;
    }
    parsed = true;
  } catch { /* fall through to generic message */ }

  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
  const summary = parsed && parts.length > 0 ? parts.join(', ') : 'issues found';

  const shouldFail =
    (errors > 0 && resolved.onError === 'fail') ||
    (warnings > 0 && resolved.onWarning === 'fail') ||
    (!parsed && resolved.onError === 'fail');

  if (shouldFail) {
    console.error(`  ✗ ESLint: ${summary}`);
    return false;
  }

  console.warn(`  ⚠ ESLint: ${summary}`);
  return true;
};

const runCommand = async (command: string, args: string[], description: string, cwd: string): Promise<void> => {
  console.log(`\n🔨 ${description}...`);

  const proc = Bun.spawn([command, ...args], { stdout: 'inherit', stderr: 'inherit', cwd });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`${description} failed with exit code ${exitCode}`);
  }
};

const performCleanInstall = async (projectRoot: string): Promise<void> => {
  console.log('\n🧹 Removing all node_modules...');

  const result = await $`find ${projectRoot} -name node_modules -type d -prune`.quiet();
  const dirs = result.stdout.toString().trim().split('\n').filter(Boolean);

  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
    console.log(`  ✓ Removed ${dir.replace(projectRoot, '.')}`);
  }

  console.log('\n📦 Running bun install...');
  const proc = Bun.spawn(['bun', 'install'], { stdout: 'inherit', stderr: 'inherit', cwd: projectRoot });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error('bun install failed');
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
  await runCommand('bun', ['run', '--filter=frontend', 'build'], 'Building frontend', projectRoot);

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

/**
 * Runs a step and files its return value under its key, so later steps can read it.
 * Array-form steps have no key and contribute nothing; a step returning nothing
 * leaves no key behind rather than an `undefined` one.
 */
const runStep = async (step: NormalizedStep, phase: 'pre' | 'post', ctx: BuildContext): Promise<void> => {
  console.log(`\n🔧 ${step.name}...`);
  const result = await step.run(ctx);
  if (step.key !== undefined && result !== undefined) {
    ctx.results[phase][step.key] = result;
  }
};

const runBuild = async (_args: string[]): Promise<void> => {
  const startTime = performance.now();
  const projectRoot = process.cwd();
  const buildDir = join(projectRoot, 'build');
  // One live object threaded through every step — later steps read what earlier ones wrote.
  const results: StepResults = { pre: {}, post: {} };
  const ctx: BuildContext = { projectRoot, buildDir, results };

  console.log('🚀 Starting production build...');
  console.log(`📁 Project root: ${projectRoot}`);

  try {
    const config = await loadConfig(projectRoot);
    type RawBuild = { cleanInstall?: boolean; typecheck?: TypeCheckLevel; lint?: LintCheckLevel; pre?: BuildSteps; post?: BuildSteps; steps?: BuildStep[] };
    const build = (config.build ?? {}) as RawBuild;

    // Validate before anything runs, so a bad config never leaves a half-built tree.
    const { errors, warnings } = validateBuildConfig(config);
    for (const warning of warnings) console.warn(`  ⚠ ${warning}`);
    if (errors.length > 0) {
      console.error('\n❌ Invalid build config in gyoza.config.ts:');
      for (const error of errors) console.error(`  ✗ ${error}`);
      process.exit(1);
    }

    const legacySteps = build.steps ?? [];
    const preSteps = normalizeSteps(build.pre, legacySteps.filter(s => s.phase === 'pre'));
    const postSteps = normalizeSteps(build.post, legacySteps.filter(s => s.phase !== 'pre'));

    const [typecheckOk, lintOk] = await Promise.all([
      runTypecheck(projectRoot, build.typecheck ?? 'off'),
      runLint(projectRoot, build.lint ?? 'off'),
    ]);

    if (!typecheckOk || !lintOk) {
      console.error('\n❌ Pre-build checks failed. Fix issues or set the level to "warn" to proceed.');
      process.exit(1);
    }

    if (build.cleanInstall) await performCleanInstall(projectRoot);

    await cleanBuildDir(buildDir);

    for (const step of preSteps) await runStep(step, 'pre', ctx);

    await buildFrontend(projectRoot);
    await buildServer(projectRoot, buildDir);
    await assembleDist(projectRoot, buildDir);

    for (const step of postSteps) await runStep(step, 'post', ctx);

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
