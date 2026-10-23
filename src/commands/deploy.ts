import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
import { loadConfig, validateDeployConfig } from '../config.ts';
import type { DeployConfig, DeployMigrateContext } from '../config.ts';
import type { CommandFlag } from '../gyoza.ts';
import { confirm } from '../prompt.ts';
import { compareVersions } from '../version.ts';
import { readPackageJson, rootPackagePath } from '../workspaces.ts';
import { runBuild } from './build.ts';
import { describeInstall, gyozaPackageDir, installChanged, readGyozaInstall } from './upgrade.ts';
import type { GyozaInstall } from './upgrade.ts';

export const description = 'Pull, install, migrate, build, and restart the service';

export const flags: CommandFlag[] = [
  { flag: '--dry', description: 'Print the deploy plan and exit without changing anything' },
  { flag: '-y, --yes', description: 'Skip confirmation prompts' },
  { flag: '--force', description: 'Build and restart even when the pull brought no changes' },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(['--dry', '-y', '--yes', '--force']);

/**
 * Internal, unlisted flag: a pre-install gyoza hands the deploy to the gyoza that
 * `bun install` just put in place. This is a contract between gyoza versions —
 * never rename or reshape it.
 */
export const RESUME_FLAG = '--resume-after-install';

/** First release that understands {@link RESUME_FLAG}. Handing off to anything older would fail on the flag. */
export const RESUME_SINCE = '0.12.0';

const SHA = /^[0-9a-f]{7,40}$/;

export interface DeployArgs {
  dry: boolean;
  yes: boolean;
  force: boolean;
  /** Set only by a handoff — the pull and install already ran between these refs. */
  resume?: { fromRef: string; toRef: string };
}

export const resumeArg = (fromRef: string, toRef: string): string => `${RESUME_FLAG}=${fromRef}..${toRef}`;

export const parseDeployArgs = (args: string[]): DeployArgs => {
  let dry = false;
  let yes = false;
  let force = false;
  let resume: DeployArgs['resume'];

  for (const arg of args) {
    if (arg.startsWith(`${RESUME_FLAG}=`)) {
      const [fromRef = '', toRef = '', ...rest] = arg.slice(RESUME_FLAG.length + 1).split('..');
      if (rest.length > 0 || !SHA.test(fromRef) || !SHA.test(toRef)) {
        throw new Error(`${RESUME_FLAG} expects <from-sha>..<to-sha>, got "${arg}".`);
      }
      resume = { fromRef, toRef };
      continue;
    }
    if (!BOOLEAN_FLAGS.has(arg)) {
      throw new Error(`"${arg}" is not a recognized flag for gyoza deploy.\n  Supported: --dry, -y/--yes, --force`);
    }
    if (arg === '--dry') dry = true;
    else if (arg === '--force') force = true;
    else yes = true;
  }

  return resume ? { dry, yes, force, resume } : { dry, yes, force };
};

/**
 * Should the deploy hand off to the gyoza `bun install` just installed? Only if
 * the install changed, and only to a release that understands {@link RESUME_FLAG}.
 */
export const handoffDecision = (before: GyozaInstall, after: GyozaInstall): 'none' | 'handoff' | 'too-old' => {
  if (!installChanged(before, after) || after.version === undefined) return 'none';
  return compareVersions(after.version, RESUME_SINCE) >= 0 ? 'handoff' : 'too-old';
};

export interface DetectedChanges {
  lockChanged: boolean;
  configChanged: boolean;
  sqlFiles: string[];
}

/** Reads `git diff --name-only` output: did the lockfile or root config move, and which `.sql` files changed. */
export const detectChanges = (diffNameOnly: string): DetectedChanges => {
  const files = diffNameOnly.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    lockChanged: files.some((f) => f === 'bun.lock' || f.endsWith('/bun.lock')),
    configChanged: files.includes('gyoza.config.ts'),
    sqlFiles: files.filter((f) => f.toLowerCase().endsWith('.sql')),
  };
};

/** `'app'` / `['app', 'worker.service']` → a `.service`-suffixed list for `systemctl restart`. */
export const normalizeServices = (service: string | string[]): string[] =>
  (Array.isArray(service) ? service : [service])
    .map((unit) => unit.trim())
    .filter(Boolean)
    .map((unit) => (unit.endsWith('.service') ? unit : `${unit}.service`));

export const currentBranch = (gitOutput: string): string => gitOutput.trim();

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const capture = async (cmd: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', cwd });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const stream = async (cmd: string[], cwd: string): Promise<number> => {
  const proc = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', cwd });
  return proc.exited;
};

const fail = (message: string): never => {
  throw new Error(message);
};

const nonInteractive = (): boolean => !process.stdin.isTTY;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const describeMigrate = (migrate: DeployConfig['migrate'], sqlCount: number): string => {
  if (typeof migrate === 'string') return `bun run ${migrate}`;
  if (typeof migrate === 'function') return 'deploy.migrate callback';
  if (sqlCount > 0) return `not configured — ${sqlCount} .sql file${sqlCount === 1 ? '' : 's'} changed, would prompt`;
  return 'not configured — no .sql changes';
};

const describeService = (service: DeployConfig['service']): string =>
  service === undefined ? 'not configured — would prompt' : `sudo systemctl restart ${normalizeServices(service).join(' ')}`;

const printDryPlan = async (cwd: string, branch: string, deploy: DeployConfig): Promise<void> => {
  console.log('Deploy plan (dry run)\n');
  console.log(`  Branch:      ${branch}`);
  console.log(`  Pull:        git pull --ff-only origin ${branch}`);

  const fetch = await capture(['git', 'fetch', 'origin', branch], cwd);
  if (fetch.exitCode !== 0) {
    console.log(`  Incoming:    could not fetch origin/${branch} — ${fetch.stderr.trim().split('\n')[0] ?? ''}`);
    return;
  }

  const range = `HEAD..origin/${branch}`;
  const commits = (await capture(['git', 'log', '--oneline', range], cwd)).stdout.trim();
  const changes = detectChanges((await capture(['git', 'diff', '--name-only', range], cwd)).stdout);

  if (commits === '') {
    console.log('  Incoming:    up to date — nothing to deploy (use --force to rebuild and restart)');
  } else {
    const lines = commits.split('\n');
    console.log(`  Incoming:    ${lines.length} commit${lines.length === 1 ? '' : 's'}`);
    for (const line of lines) console.log(`               ${line}`);
  }

  console.log(`  bun install: ${changes.lockChanged ? 'yes — bun.lock changed' : 'no — bun.lock unchanged'}`);
  console.log(`  Migrate:     ${describeMigrate(deploy.migrate, changes.sqlFiles.length)}`);
  console.log('  Build:       gyoza build');
  console.log(`  Restart:     ${describeService(deploy.service)}`);
  if (changes.configChanged) {
    console.log('  Config:      gyoza.config.ts changes in this pull — migrate/restart above reflect the');
    console.log('               current config; the deploy reloads it after pulling');
  }
};

const runMigrate = async (
  cwd: string,
  migrate: DeployConfig['migrate'],
  changes: DetectedChanges,
  ctx: DeployMigrateContext,
  yes: boolean,
): Promise<void> => {
  if (typeof migrate === 'string') {
    const pkg = readPackageJson<PackageJson>(rootPackagePath(cwd));
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    if (!Object.hasOwn(scripts, migrate)) {
      fail(`deploy.migrate names "${migrate}", which is not a script in package.json.`);
    }
    console.log(`\n🗄  Running migrations (bun run ${migrate})...`);
    const code = await stream(['bun', 'run', migrate], cwd);
    if (code !== 0) fail(`Migration script "${migrate}" failed (exit ${code}).`);
    return;
  }

  if (typeof migrate === 'function') {
    console.log('\n🗄  Running migrations (deploy.migrate callback)...');
    await migrate(ctx);
    return;
  }

  // Not configured — only an issue if the pull carried schema changes.
  if (changes.sqlFiles.length === 0) return;

  const n = changes.sqlFiles.length;
  console.log(`\n⚠  ${n} SQL file${n === 1 ? '' : 's'} changed in this pull, but deploy.migrate is not configured.`);
  if (!yes && nonInteractive()) {
    fail(
      'gyoza cannot prompt in a non-interactive shell.\n' +
        '  Set deploy.migrate in gyoza.config.ts, or pass --yes to continue without migrating.',
    );
  }
  const proceed = yes || (await confirm('Continue the deploy without running migrations?', false));
  if (!proceed) fail('Aborted — set deploy.migrate in gyoza.config.ts.');
};

const loadDeployConfig = async (cwd: string): Promise<DeployConfig> => {
  const config = await loadConfig(cwd);
  const { errors } = validateDeployConfig(config);
  if (errors.length > 0) {
    console.error('\n❌ Invalid deploy config in gyoza.config.ts:');
    for (const error of errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }
  return config.deploy ?? {};
};

const confirmNoService = async (yes: boolean): Promise<void> => {
  if (!yes && nonInteractive()) {
    fail(
      'deploy.service is not configured and gyoza cannot prompt in a non-interactive shell.\n' +
        '  Set deploy.service in gyoza.config.ts, or pass --yes to deploy without a restart.',
    );
  }
  const proceed =
    yes || (await confirm('No deploy.service configured. Finish the deploy without restarting a service?', false));
  if (!proceed) fail('Aborted — set deploy.service in gyoza.config.ts.');
};

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const diffRefs = async (
  cwd: string,
  fromRef: string,
  toRef: string,
): Promise<{ changes: DetectedChanges; changedFiles: string[] }> => {
  const diffOut = (await capture(['git', 'diff', '--name-only', fromRef, toRef], cwd)).stdout;
  return {
    changes: detectChanges(diffOut),
    changedFiles: diffOut.split('\n').map((line) => line.trim()).filter(Boolean),
  };
};

/** Migrate → build → restart. Shared by a normal deploy and a post-install handoff. */
const finishDeploy = async (
  cwd: string,
  deploy: DeployConfig,
  branch: string,
  diff: { changes: DetectedChanges; changedFiles: string[] },
  before: string,
  after: string,
  yes: boolean,
): Promise<void> => {
  await runMigrate(
    cwd,
    deploy.migrate,
    diff.changes,
    { projectRoot: cwd, changedFiles: diff.changedFiles, fromRef: before, toRef: after },
    yes,
  );

  console.log('\n🏗  Building...');
  await runBuild([]);

  if (deploy.service !== undefined) {
    const units = normalizeServices(deploy.service);
    console.log(`\n♻  Restarting ${units.join(', ')}...`);
    const code = await stream(['sudo', 'systemctl', 'restart', ...units], cwd);
    if (code !== 0) {
      fail(
        `sudo systemctl restart ${units.join(' ')} failed (exit ${code}).\n` +
          '  The deploy user needs a NOPASSWD sudoers entry for this unit, or run gyoza deploy as root.',
      );
    }
  }

  console.log(`\n✅  Deployed ${branch}  ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
};

const runDeploy = async (args: string[]): Promise<void> => {
  const cwd = process.cwd();

  try {
    const { dry, yes, force, resume } = parseDeployArgs(args);

    let deploy = await loadDeployConfig(cwd);

    // --- git preflight: nothing is mutated past this point on failure ---
    const insideRepo = await capture(['git', 'rev-parse', '--is-inside-work-tree'], cwd);
    if (insideRepo.exitCode !== 0 || insideRepo.stdout.trim() !== 'true') {
      fail(`${cwd} is not inside a git working tree — nothing to pull.`);
    }
    if ((await capture(['git', 'symbolic-ref', '--quiet', 'HEAD'], cwd)).exitCode !== 0) {
      fail('HEAD is detached — check out a branch before deploying.');
    }

    const branchOut = await capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    if (branchOut.exitCode !== 0) fail('Could not determine the current branch.');
    const branch = currentBranch(branchOut.stdout);

    // Handed off by the previous gyoza after bun install replaced it. The pull,
    // install, and no-service confirmation already happened in that process.
    if (resume) {
      console.log(`\n🔁  Resuming deploy in gyoza ${describeInstall(readGyozaInstall(gyozaPackageDir()))}...`);
      const diff = await diffRefs(cwd, resume.fromRef, resume.toRef);
      await finishDeploy(cwd, deploy, branch, diff, resume.fromRef, resume.toRef, yes);
      return;
    }

    if (dry) {
      await printDryPlan(cwd, branch, deploy);
      return;
    }

    const status = await capture(['git', 'status', '--porcelain'], cwd);
    if (status.exitCode !== 0) fail('git status failed.');
    if (status.stdout.trim() !== '') {
      fail('The working tree has uncommitted changes. Commit or stash them before deploying.');
    }

    // Settle the service question before pulling, so an unattended run fails fast.
    if (deploy.service === undefined) await confirmNoService(yes);

    const before = (await capture(['git', 'rev-parse', 'HEAD'], cwd)).stdout.trim();

    console.log(`\n⬇  Pulling origin/${branch} (fast-forward only)...`);
    const pull = await stream(['git', 'pull', '--ff-only', 'origin', branch], cwd);
    if (pull !== 0) {
      fail(
        `git pull --ff-only origin ${branch} failed (exit ${pull}).\n` +
          '  The server tree has diverged from the remote — resolve it manually and re-run.',
      );
    }

    const after = (await capture(['git', 'rev-parse', 'HEAD'], cwd)).stdout.trim();
    const diff = await diffRefs(cwd, before, after);
    const { changes } = diff;

    if (before === after && !force) {
      console.log('\n✓  Already up to date — nothing to deploy. (use --force to rebuild and restart)');
      return;
    }

    // Everything past the pull must run against the config it brought in.
    if (changes.configChanged) {
      console.log('\n🔁  gyoza.config.ts changed — reloading config...');
      const hadService = deploy.service !== undefined;
      deploy = await loadDeployConfig(cwd);
      // Only ask if the pull removed the service — an unset one was already confirmed above.
      if (hadService && deploy.service === undefined) await confirmNoService(yes);
    }

    if (changes.lockChanged) {
      // The running gyoza's own package — not cwd — since the question is whether
      // this install is about to replace the code doing the deploy.
      const packageDir = gyozaPackageDir();
      const gyozaBefore = readGyozaInstall(packageDir);

      console.log('\n📦  bun.lock changed — running bun install...');
      const code = await stream(['bun', 'install'], cwd);
      if (code !== 0) fail(`bun install failed (exit ${code}).`);

      // Everything past the install must run in the gyoza it installed.
      const gyozaAfter = readGyozaInstall(packageDir);
      const decision = handoffDecision(gyozaBefore, gyozaAfter);
      const moved = `gyoza ${describeInstall(gyozaBefore)} → ${describeInstall(gyozaAfter)}`;

      if (decision === 'handoff') {
        console.log(`\n🔁  bun install moved ${moved} — handing the deploy to the new version...`);
        const handoffArgs = [resumeArg(before, after), ...(yes ? ['--yes'] : [])];
        process.exit(await stream(['bun', join(packageDir, 'cli.ts'), 'deploy', ...handoffArgs], cwd));
      }
      if (decision === 'too-old') {
        console.log(
          `\n⚠  bun install moved ${moved}, which predates deploy handoff (${RESUME_SINCE}).\n` +
            `   Finishing this deploy in gyoza ${describeInstall(gyozaBefore)}.`,
        );
      }
    } else {
      console.log('\n·  bun.lock unchanged — skipping bun install.');
    }

    await finishDeploy(cwd, deploy, branch, diff, before, after, yes);
  } catch (err) {
    console.error(`\n  ✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
};

export { runDeploy, runDeploy as run };
