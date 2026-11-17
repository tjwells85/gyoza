import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateDeployConfig } from '../src/config.ts';
import type { GyozaConfig } from '../src/config.ts';
import {
  currentBranch,
  detectChanges,
  FORCE_NOTICE,
  handoffArgs,
  handoffDecision,
  normalizeServices,
  parseDeployArgs,
  PREFLIGHT_SINCE,
  RESUME_FLAG,
  RESUME_SINCE,
  resumeArg,
  runDeploy,
} from '../src/commands/deploy.ts';

// ---------------------------------------------------------------------------
// parseDeployArgs
// ---------------------------------------------------------------------------

describe('parseDeployArgs', () => {
  const none = { dry: false, yes: false, skipPreflight: false };

  test('defaults everything to false', () => {
    expect(parseDeployArgs([])).toEqual(none);
  });

  test('reads --dry, --skip-preflight, and both -y / --yes', () => {
    expect(parseDeployArgs(['--dry'])).toEqual({ ...none, dry: true });
    expect(parseDeployArgs(['-y'])).toEqual({ ...none, yes: true });
    expect(parseDeployArgs(['--skip-preflight'])).toEqual({ ...none, skipPreflight: true });
    expect(parseDeployArgs(['--yes', '--dry'])).toEqual({ ...none, dry: true, yes: true });
  });

  test('throws on an unknown flag, naming the supported ones', () => {
    expect(() => parseDeployArgs(['--skip-build'])).toThrow(/not a recognized flag/);
    expect(() => parseDeployArgs(['--skip-build'])).toThrow(/--dry, -y\/--yes, --skip-preflight$/);
  });

  test('accepts the deprecated --force flag as a no-op', () => {
    expect(parseDeployArgs(['--force'])).toEqual(none);
    expect(parseDeployArgs(['--force', '-y'])).toEqual({ ...none, yes: true });
  });

  test('round-trips the handoff flag alongside --yes', () => {
    const from = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const to = 'e4f5a6b';
    expect(parseDeployArgs([resumeArg(from, to), '--yes'])).toEqual({
      dry: false,
      yes: true,
      skipPreflight: false,
      resume: { fromRef: from, toRef: to },
    });
  });

  test('round-trips handoffArgs, including --skip-preflight', () => {
    const from = 'a1b2c3d';
    const to = 'e4f5a6b';
    const args = handoffArgs(from, to, { yes: true, skipPreflight: true }, PREFLIGHT_SINCE);
    expect(parseDeployArgs(args)).toEqual({
      dry: false,
      yes: true,
      skipPreflight: true,
      resume: { fromRef: from, toRef: to },
    });
  });

  test('handoffArgs does not send --skip-preflight to a child that predates it', () => {
    expect(handoffArgs('a1b2c3d', 'e4f5a6b', { yes: false, skipPreflight: true }, RESUME_SINCE)).toEqual([
      resumeArg('a1b2c3d', 'e4f5a6b'),
    ]);
  });

  test('rejects a malformed handoff range', () => {
    expect(() => parseDeployArgs([`${RESUME_FLAG}=a1b2c3d`])).toThrow(/expects <from-sha>\.\.<to-sha>/);
    expect(() => parseDeployArgs([`${RESUME_FLAG}=HEAD..e4f5a6b`])).toThrow(/expects/);
    expect(() => parseDeployArgs([`${RESUME_FLAG}=a1b2c3d..e4f5a6b..f00ba44`])).toThrow(/expects/);
  });

  test('the bare handoff flag is not recognized', () => {
    expect(() => parseDeployArgs([RESUME_FLAG])).toThrow(/not a recognized flag/);
  });
});

// ---------------------------------------------------------------------------
// handoffDecision
// ---------------------------------------------------------------------------

describe('handoffDecision', () => {
  test('a commit change hands off even when the version did not move', () => {
    expect(handoffDecision({ version: '0.12.0', commit: '03d9105' }, { version: '0.12.0', commit: '6b836bc' })).toBe(
      'handoff',
    );
  });

  test('the same commit is no handoff', () => {
    expect(handoffDecision({ version: '0.12.0', commit: '03d9105' }, { version: '0.12.0', commit: '03d9105' })).toBe(
      'none',
    );
  });

  test('falls back to the version when either side has no commit', () => {
    expect(handoffDecision({ version: '0.12.0' }, { version: '0.12.0', commit: '03d9105' })).toBe('none');
    expect(handoffDecision({ version: '0.12.0', commit: '03d9105' }, { version: '0.13.0' })).toBe('handoff');
  });

  test('no handoff when the new version cannot be read', () => {
    expect(handoffDecision({ version: '0.12.0', commit: '03d9105' }, { commit: '6b836bc' })).toBe('none');
  });

  test('hands off to a downgrade that still understands the flag', () => {
    expect(handoffDecision({ version: '0.13.0' }, { version: RESUME_SINCE })).toBe('handoff');
  });

  test('refuses to hand off to a release that predates the flag', () => {
    expect(handoffDecision({ version: '0.12.0', commit: '03d9105' }, { version: '0.11.2', commit: '6b836bc' })).toBe(
      'too-old',
    );
  });
});

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

describe('detectChanges', () => {
  test('flags a root bun.lock', () => {
    expect(detectChanges('bun.lock\nsrc/app.ts').lockChanged).toBe(true);
  });

  test('flags a nested bun.lock', () => {
    expect(detectChanges('packages/api/bun.lock').lockChanged).toBe(true);
  });

  test('does not flag a path that merely ends in "bun.lock"', () => {
    expect(detectChanges('vendor/notbun.lock').lockChanged).toBe(false);
  });

  test('collects .sql files case-insensitively', () => {
    const changes = detectChanges('db/0001_init.sql\ndb/0002_users.SQL\nsrc/app.ts');
    expect(changes.sqlFiles).toEqual(['db/0001_init.sql', 'db/0002_users.SQL']);
  });

  test('empty diff yields no changes', () => {
    expect(detectChanges('')).toEqual({ lockChanged: false, configChanged: false, sqlFiles: [] });
    expect(detectChanges('\n  \n')).toEqual({ lockChanged: false, configChanged: false, sqlFiles: [] });
  });

  test('flags a root gyoza.config.ts only', () => {
    expect(detectChanges('gyoza.config.ts\nsrc/app.ts').configChanged).toBe(true);
    expect(detectChanges('packages/api/gyoza.config.ts').configChanged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeServices
// ---------------------------------------------------------------------------

describe('normalizeServices', () => {
  test('appends .service when missing', () => {
    expect(normalizeServices('app')).toEqual(['app.service']);
  });

  test('leaves an explicit .service alone', () => {
    expect(normalizeServices('app.service')).toEqual(['app.service']);
  });

  test('handles an array, trimming and dropping empties', () => {
    expect(normalizeServices(['app', ' worker.service ', ''])).toEqual(['app.service', 'worker.service']);
  });
});

describe('currentBranch', () => {
  test('trims the git output', () => {
    expect(currentBranch('main\n')).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// validateDeployConfig
// ---------------------------------------------------------------------------

describe('validateDeployConfig', () => {
  const diagnose = (deploy: GyozaConfig['deploy']): ReturnType<typeof validateDeployConfig> =>
    validateDeployConfig({ deploy });

  test('no deploy block is fine', () => {
    expect(validateDeployConfig({})).toEqual({ errors: [], warnings: [] });
  });

  test('accepts a script name, a callback, a string service, and an array service', () => {
    expect(diagnose({ migrate: 'db:migrate', service: 'app' }).errors).toEqual([]);
    expect(diagnose({ migrate: () => {}, service: ['app', 'worker'] }).errors).toEqual([]);
  });

  test('rejects a non-string, non-function migrate', () => {
    expect(diagnose({ migrate: 42 as unknown as string }).errors[0]).toContain('deploy.migrate must be');
  });

  test('rejects an empty migrate string', () => {
    expect(diagnose({ migrate: '  ' }).errors[0]).toContain('empty string');
  });

  test('rejects a numeric service', () => {
    expect(diagnose({ service: 3 as unknown as string }).errors[0]).toContain('deploy.service must be');
  });

  test('rejects an empty service array and blank entries', () => {
    expect(diagnose({ service: [] }).errors[0]).toContain('empty array');
    expect(diagnose({ service: ['app', ' '] }).errors[0]).toContain('deploy.service[1]');
  });
});

// ---------------------------------------------------------------------------
// loadConfig after a pull rewrites gyoza.config.ts
// ---------------------------------------------------------------------------

describe('loadConfig reload', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gyoza-deploy-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (service: string): void => {
    writeFileSync(join(dir, 'gyoza.config.ts'), `export default { deploy: { service: '${service}' } };\n`);
  };

  test('picks up a rewritten config instead of the cached module', async () => {
    writeConfig('old-app');
    expect((await loadConfig(dir)).deploy?.service).toBe('old-app');

    writeConfig('new-app');
    expect((await loadConfig(dir)).deploy?.service).toBe('new-app');
  });

  test('an unchanged config still loads', async () => {
    writeConfig('app');
    expect((await loadConfig(dir)).deploy?.service).toBe('app');
    expect((await loadConfig(dir)).deploy?.service).toBe('app');
  });
});

// ---------------------------------------------------------------------------
// runDeploy --dry against a real git repo
// ---------------------------------------------------------------------------

describe('runDeploy --dry', () => {
  let remote: string;
  let work: string;
  let origCwd: string;

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
  };

  beforeEach(() => {
    origCwd = process.cwd();
    remote = mkdtempSync(join(tmpdir(), 'gyoza-deploy-remote-'));
    work = mkdtempSync(join(tmpdir(), 'gyoza-deploy-work-'));

    git(remote, 'init', '--bare', '-b', 'main');
    git(work, 'init', '-b', 'main');
    git(work, 'remote', 'add', 'origin', remote);
    writeFileSync(join(work, 'README.md'), '# fixture\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'initial');
    git(work, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(remote, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test('prints a plan and mutates nothing when up to date', async () => {
    process.chdir(work);
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    try {
      await runDeploy(['--dry']);
    } finally {
      log.mockRestore();
    }

    const out = logs.join('\n');
    expect(out).toContain('Deploy plan (dry run)');
    expect(out).toContain('Branch:      main');
    expect(out).toContain('git pull --ff-only origin main');
    expect(out).toContain('up to date');
    expect(out).toContain('Build:       gyoza build');
    expect(out).toContain('Restart:     not configured — would prompt');

    // Working tree untouched.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: work }).toString()).toBe('');
  });

  test('--force prints the deprecation notice and otherwise changes nothing', async () => {
    process.chdir(work);
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    try {
      await runDeploy(['--dry', '--force']);
    } finally {
      log.mockRestore();
    }

    const out = logs.join('\n');
    expect(out).toContain(FORCE_NOTICE);
    expect(out).toContain('Deploy plan (dry run)');
  });

  test('reports incoming commits and a lockfile change', async () => {
    // Add a commit on the remote that the local checkout has not pulled.
    const other = mkdtempSync(join(tmpdir(), 'gyoza-deploy-other-'));
    try {
      git(other, 'clone', remote, '.');
      writeFileSync(join(other, 'bun.lock'), '# lock\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-m', 'add lockfile');
      git(other, 'push', 'origin', 'main');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }

    process.chdir(work);
    const logs: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });

    try {
      await runDeploy(['--dry']);
    } finally {
      log.mockRestore();
    }

    const out = logs.join('\n');
    expect(out).toContain('1 commit');
    expect(out).toContain('add lockfile');
    expect(out).toContain('bun install: yes — bun.lock changed');
  });

  // -------------------------------------------------------------------------
  // deploy.preflight
  // -------------------------------------------------------------------------

  const PREFLIGHT_CONFIG = `export default {
  deploy: {
    migrate: 'db:migrate-not-a-script',
    preflight: {
      checks: {
        good: () => true,
        soft: { run: () => ({ ok: false, detail: 'meh' }), onFail: 'warn' },
        bad: { run: () => ({ ok: false, detail: 'share offline' }) },
      },
    },
  },
};
`;

  const commitPreflightConfig = (): void => {
    writeFileSync(join(work, 'gyoza.config.ts'), PREFLIGHT_CONFIG);
    writeFileSync(join(work, 'package.json'), '{ "name": "fixture", "scripts": {} }\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'add preflight');
    git(work, 'push', 'origin', 'main');
  };

  /** Captures every console stream; process.exit throws so the abort can be observed. */
  const captureRun = async (args: string[]): Promise<{ out: string; exitCode: number | undefined }> => {
    const lines: string[] = [];
    const push = (...a: unknown[]): void => void lines.push(a.map(String).join(' '));
    const spies = [
      spyOn(console, 'log').mockImplementation(push),
      spyOn(console, 'warn').mockImplementation(push),
      spyOn(console, 'error').mockImplementation(push),
    ];
    let exitCode: number | undefined;
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error('process.exit');
    }) as typeof process.exit);

    try {
      await runDeploy(args);
    } catch (err) {
      if (!(err instanceof Error && err.message === 'process.exit')) throw err;
    } finally {
      for (const spy of spies) spy.mockRestore();
      exit.mockRestore();
    }
    return { out: lines.join('\n'), exitCode };
  };

  test('--dry runs the preflight and reports what would abort', async () => {
    commitPreflightConfig();
    process.chdir(work);

    const { out, exitCode } = await captureRun(['--dry']);

    expect(exitCode).toBeUndefined();
    expect(out).toContain('Preflight:   0 deps, 3 checks — results below');
    expect(out).toContain('✓ good');
    expect(out).toContain('⚠ soft  meh');
    expect(out).toContain('✗ bad   share offline');
    expect(out).toContain('1 failing check would abort the deploy');
  });

  test('a failing preflight aborts before migrate', async () => {
    commitPreflightConfig();
    process.chdir(work);

    const { out, exitCode } = await captureRun(['-y']);

    expect(exitCode).toBe(1);
    expect(out).toContain('Preflight failed (1 check)');
    // migrate would have failed on the missing script — it never ran.
    expect(out).not.toContain('db:migrate-not-a-script');
  });

  test('--skip-preflight goes straight to migrate', async () => {
    commitPreflightConfig();
    process.chdir(work);

    const { out, exitCode } = await captureRun(['-y', '--skip-preflight']);

    expect(exitCode).toBe(1);
    expect(out).toContain('Skipping deploy.preflight');
    expect(out).not.toContain('share offline');
    expect(out).toContain('deploy.migrate names "db:migrate-not-a-script"');
  });
});
