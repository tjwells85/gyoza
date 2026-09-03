import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDeployConfig } from '../src/config.ts';
import type { GyozaConfig } from '../src/config.ts';
import {
  currentBranch,
  detectChanges,
  normalizeServices,
  parseDeployArgs,
  runDeploy,
} from '../src/commands/deploy.ts';

// ---------------------------------------------------------------------------
// parseDeployArgs
// ---------------------------------------------------------------------------

describe('parseDeployArgs', () => {
  test('defaults everything to false', () => {
    expect(parseDeployArgs([])).toEqual({ dry: false, yes: false, force: false });
  });

  test('reads --dry, --force, and both -y / --yes', () => {
    expect(parseDeployArgs(['--dry'])).toEqual({ dry: true, yes: false, force: false });
    expect(parseDeployArgs(['--force'])).toEqual({ dry: false, yes: false, force: true });
    expect(parseDeployArgs(['-y'])).toEqual({ dry: false, yes: true, force: false });
    expect(parseDeployArgs(['--yes', '--dry', '--force'])).toEqual({ dry: true, yes: true, force: true });
  });

  test('throws on an unknown flag, naming the supported ones', () => {
    expect(() => parseDeployArgs(['--skip-build'])).toThrow(/not a recognized flag/);
    expect(() => parseDeployArgs(['--skip-build'])).toThrow(/--dry, -y\/--yes, --force/);
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
    expect(detectChanges('')).toEqual({ lockChanged: false, sqlFiles: [] });
    expect(detectChanges('\n  \n')).toEqual({ lockChanged: false, sqlFiles: [] });
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
});
