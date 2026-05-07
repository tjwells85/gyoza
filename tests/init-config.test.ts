import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isLegacyConfig,
  extractBuildStepsLiteral,
  migrateLegacyConfig,
  run as runInitConfig,
} from '../src/commands/init/config.ts';

// ---------------------------------------------------------------------------
// isLegacyConfig
// ---------------------------------------------------------------------------

describe('isLegacyConfig', () => {
  test('detects export const buildSteps', () => {
    expect(isLegacyConfig(`export const buildSteps: BuildStep[] = [];`)).toBe(true);
  });

  test('detects without type annotation', () => {
    expect(isLegacyConfig(`export const buildSteps = [];`)).toBe(true);
  });

  test('returns false for new-format config', () => {
    expect(isLegacyConfig(`export default { build: { post: [] } } satisfies GyozaConfig;`)).toBe(false);
  });

  test('returns false for unrelated source', () => {
    expect(isLegacyConfig(`const x = 1;`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractBuildStepsLiteral
// ---------------------------------------------------------------------------

describe('extractBuildStepsLiteral', () => {
  test('extracts a simple array', () => {
    const source = `export const buildSteps: BuildStep[] = [
  { name: 'test', run: async () => {} },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("name: 'test'");
    expect(result!.startsWith('[')).toBe(true);
    expect(result!.endsWith(']')).toBe(true);
  });

  test('handles nested arrays without truncating', () => {
    const source = `export const buildSteps = [
  {
    name: 'build',
    run: async () => {
      Bun.spawn(['cargo', 'build', '--release']);
    },
  },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("['cargo', 'build', '--release']");
  });

  test('handles template literals with ${} expressions', () => {
    const source = `export const buildSteps = [
  {
    name: 'copy',
    run: async ({ buildDir }) => {
      await Bun.write(\`\${buildDir}/output\`, 'data');
    },
  },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain('`${buildDir}/output`');
  });

  test('handles ] inside a string literal', () => {
    const source = `export const buildSteps = [
  { name: 'step [0]', run: async () => {} },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("'step [0]'");
  });

  test('handles ] inside a line comment', () => {
    const source = `export const buildSteps = [
  // this ] should be ignored
  { name: 'step', run: async () => {} },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("name: 'step'");
  });

  test('handles ] inside a block comment', () => {
    const source = `export const buildSteps = [
  /* ] bracket in comment */
  { name: 'step', run: async () => {} },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("name: 'step'");
  });

  test('handles escape sequences inside strings', () => {
    const source = `export const buildSteps = [
  { name: 'it\\'s a step', run: async () => {} },
];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).not.toBeNull();
    expect(result).toContain("it\\'s a step");
  });

  test('returns [] for an empty array', () => {
    const source = `export const buildSteps: BuildStep[] = [];`;
    const result = extractBuildStepsLiteral(source);
    expect(result).toBe('[]');
  });

  test('returns null for unbalanced brackets', () => {
    const source = `export const buildSteps = [
  { name: 'oops'
`;
    expect(extractBuildStepsLiteral(source)).toBeNull();
  });

  test('returns null when no buildSteps export is found', () => {
    expect(extractBuildStepsLiteral(`export default {};`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// migrateLegacyConfig
// ---------------------------------------------------------------------------

describe('migrateLegacyConfig', () => {
  test('produces new-format output with steps preserved', () => {
    const source = `import type { BuildStep } from 'gyoza';

export const buildSteps: BuildStep[] = [
  {
    name: 'Deploy',
    phase: 'post',
    run: async ({ buildDir }) => {
      console.log(buildDir);
    },
  },
];`;
    const result = migrateLegacyConfig(source);
    expect(result).not.toBeNull();
    expect(result).toContain("import type { GyozaConfig } from 'gyoza'");
    expect(result).toContain('satisfies GyozaConfig');
    expect(result).toContain('steps:');
    expect(result).toContain("name: 'Deploy'");
    expect(result).toContain("phase: 'post'");
    expect(result).toContain('console.log(buildDir)');
  });

  test('returns null for unbalanced source', () => {
    expect(migrateLegacyConfig(`export const buildSteps = [`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration — writes a complex legacy config, migrates, validates output
// ---------------------------------------------------------------------------

describe('integration: migrate complex legacy config', () => {
  let tmpDir: string;
  let originalCwd: string;

  const COMPLEX_LEGACY_CONFIG = `import type { BuildStep } from 'gyoza';

// Build pipeline steps
export const buildSteps: BuildStep[] = [
  {
    name: 'Build Rust CLI',
    phase: 'post',
    run: async ({ buildDir }) => {
      // spawn with nested array args
      const proc = Bun.spawn(['cargo', 'build', '--release', '--target', 'x86_64-unknown-linux-gnu'], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      await proc.exited;
      /* copy binary to build dir */
      await Bun.write(\`\${buildDir}/mycli\`, Bun.file('target/release/mycli'));
    },
  },
  {
    name: 'Write manifest',
    phase: 'pre',
    run: async ({ projectRoot, buildDir }) => {
      const entries = ['server.js', 'client/', '.env'];
      const manifest = entries.map(e => \`\${buildDir}/\${e}\`).join('\\n');
      await Bun.write(\`\${projectRoot}/build.manifest\`, manifest);
    },
  },
  {
    name: 'Step with tricky strings',
    run: async () => {
      const x = 'value with ] bracket and [ another';
      const y = "double-quoted ] string";
      console.log(x, y);
    },
  },
];
`;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `gyoza-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    Bun.write(join(tmpDir, 'gyoza.config.ts'), COMPLEX_LEGACY_CONFIG);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('migrates without error', async () => {
    await runInitConfig([]);
    expect(existsSync(join(tmpDir, 'gyoza.config.ts'))).toBe(true);
  });

  test('output imports GyozaConfig', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain("import type { GyozaConfig } from 'gyoza'");
  });

  test('output uses satisfies GyozaConfig', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain('satisfies GyozaConfig');
  });

  test('output contains steps field', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain('steps:');
  });

  test('preserves nested spawn array', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain("['cargo', 'build', '--release', '--target', 'x86_64-unknown-linux-gnu']");
  });

  test('preserves template literals', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain('`${buildDir}/mycli`');
  });

  test('preserves strings containing brackets', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain("'value with ] bracket and [ another'");
  });

  test('preserves all three step names', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain("name: 'Build Rust CLI'");
    expect(output).toContain("name: 'Write manifest'");
    expect(output).toContain("name: 'Step with tricky strings'");
  });

  test('preserves phase values', () => {
    const output = readFileSync(join(tmpDir, 'gyoza.config.ts'), 'utf8');
    expect(output).toContain("phase: 'post'");
    expect(output).toContain("phase: 'pre'");
  });

  test('does not migrate again if already migrated', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as () => never);
    try {
      await runInitConfig([]);
      expect.unreachable('should have called process.exit(1)');
    } catch (err) {
      expect((err as Error).message).toBe('process.exit called');
    } finally {
      exitSpy.mockRestore();
    }
  });
});
