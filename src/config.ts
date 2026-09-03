import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Values returned by steps that have already run, keyed by their step key. */
export interface StepResults {
  pre: Record<string, unknown>;
  post: Record<string, unknown>;
}

export interface BuildContext {
  projectRoot: string;
  buildDir: string;
  results: StepResults;
}

export interface BuildStep {
  name: string;
  /**
   * @deprecated Use the top-level `build.pre` or `build.post` arrays instead.
   * 'pre' runs after clean, before frontend/server build. 'post' runs after assembly. Defaults to 'post'.
   */
  phase?: 'pre' | 'post';
  run(ctx: BuildContext): unknown;
}

/**
 * A step in the keyed (object) form of `build.pre` / `build.post`. The object key
 * identifies the step and is where its return value lands in `ctx.results`.
 */
export interface BuildStepEntry {
  /** Display label for build output. Defaults to the step's key. */
  name?: string;
  run(ctx: BuildContext): unknown;
}

export type BuildStepMap = Record<string, BuildStepEntry>;

/**
 * Steps get typed access to the *previous* phase's results; same-phase results
 * are readable at runtime but typed `unknown`.
 *
 * This asymmetry is forced. Typing a phase's own results means the type inferred
 * from that phase's step map is also referenced inside that same map's parameter
 * positions, and TypeScript breaks the cycle by collapsing the reading step's own
 * return type to `unknown`. That surfaces as an error in whichever *later* step
 * consumes the value, nowhere near the cause. A uniform rule with no landmine
 * beats same-phase typing that silently degrades.
 */
export type PreStepContext = Omit<BuildContext, 'results'> & {
  results: { pre: Record<string, unknown>; post: Record<string, never> };
};

/** Context passed to `build.post` steps. All `pre` steps have completed by now. */
export type PostStepContext<TPre> = Omit<BuildContext, 'results'> & {
  results: { pre: TPre; post: Record<string, unknown> };
};

/** What to do when a check finds issues: print a warning and continue, or fail the build. */
export type CheckAction = 'warn' | 'fail';

/**
 * How to handle `tsc --noEmit` before the build.
 * - `'off'`  — skip (default)
 * - `'warn'` — run, print error count, continue
 * - `'fail'` — run, print error count, abort if any errors
 */
export type TypeCheckLevel = 'off' | 'warn' | 'fail';

/**
 * How to handle `eslint .` before the build.
 * - `'off'`  — skip (default)
 * - `'warn'` — run, print counts, continue regardless
 * - `'fail'` — run, print counts, abort if any errors or warnings
 * - object   — fine-grained: set `onError` / `onWarning` independently
 */
export type LintCheckLevel =
  | 'off'
  | 'warn'
  | 'fail'
  | { onError: CheckAction; onWarning: CheckAction };

/** Either the keyed form (preferred) or the deprecated array form. */
export type BuildSteps = BuildStepMap | Omit<BuildStep, 'phase'>[];

export interface BuildConfig {
  /** Remove all node_modules recursively before building, then run `bun install`. Default: false. */
  cleanInstall?: boolean;
  /** Run `tsc --noEmit` before the build. Default: 'off'. */
  typecheck?: TypeCheckLevel;
  /** Run `eslint .` before the build. Default: 'off'. */
  lint?: LintCheckLevel;
  /** Steps to run after clean, before the frontend/server build. */
  pre?: BuildSteps;
  /** Steps to run after assembly. */
  post?: BuildSteps;
  /**
   * @deprecated Use `pre` and `post` instead.
   * Supported for backward compatibility — steps are routed by their `phase` field.
   */
  steps?: BuildStep[];
}

export interface CustomScripts {
  init?: Record<string, () => void | Promise<void>>;
  generate?: Record<string, () => void | Promise<void>>;
}

/** Context handed to a `deploy.migrate` callback. */
export interface DeployMigrateContext {
  /** process.cwd() of the project being deployed. */
  projectRoot: string;
  /** Paths from `git diff --name-only <before>..<after>` for the pull just applied. */
  changedFiles: string[];
  /** HEAD sha before the pull. */
  fromRef: string;
  /** HEAD sha after the pull. */
  toRef: string;
}

/**
 * The migration step run by `gyoza deploy`. Either a `package.json` script name
 * (run as `bun run <name>`) or a callback for custom logic.
 */
export type DeployMigrate = string | ((ctx: DeployMigrateContext) => unknown);

export interface DeployConfig {
  /** DB migration step: a `package.json` script name or a callback. Default: none — `gyoza deploy` prompts. */
  migrate?: DeployMigrate;
  /**
   * systemd unit(s) for `gyoza deploy` to restart via `sudo systemctl restart`.
   * `'app'` or `'app.service'`; an array restarts every unit in one call. Default: none — `gyoza deploy` prompts.
   */
  service?: string | string[];
}

export interface GyozaConfig {
  build?: BuildConfig;
  custom?: CustomScripts;
  deploy?: DeployConfig;
}

export const defaultConfig: GyozaConfig = {
  build: {
    cleanInstall: false,
  },
};

/**
 * Marks a config as having come from `defineConfig`. `Symbol.for` rather than a
 * module-local symbol so the check survives a duplicated gyoza install.
 */
const GYOZA_CONFIG = Symbol.for('gyoza.config');

const brand = <T extends object>(config: T): T => {
  Object.defineProperty(config, GYOZA_CONFIG, { value: true, enumerable: false });
  return config;
};

export const isDefinedConfig = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[GYOZA_CONFIG] === true;

type PreStepsOf<TPre> = {
  [K in keyof TPre]: { name?: string; run: (ctx: PreStepContext) => TPre[K] | Promise<TPre[K]> };
};

type PostStepsOf<TPre> = Record<string, { name?: string; run: (ctx: PostStepContext<TPre>) => unknown }>;

/** The deprecated array form, still accepted so a config can be wrapped before its steps are keyed. */
type LegacyStepArray = Omit<BuildStep, 'phase'>[];

export interface DefineConfigInput<TPre> {
  build?: Omit<BuildConfig, 'pre' | 'post' | 'steps'> & {
    pre?: PreStepsOf<TPre> | LegacyStepArray;
    post?: PostStepsOf<TPre> | LegacyStepArray;
    /** @deprecated Move entries into `pre` / `post` and drop the phase field. */
    steps?: BuildStep[];
  };
  custom?: CustomScripts;
  deploy?: DeployConfig;
}

/**
 * Defines a gyoza config with typed step results. A `pre` step's return value is
 * available to every `post` step as `ctx.results.pre.<key>`, with the exact type
 * it returned and no annotations required.
 *
 * Same-phase results (`pre` reading `pre`, `post` reading `post`) are readable but
 * typed `unknown` — see the note on `PreStepContext` for why.
 *
 * This is the only typed path — a bare object with `satisfies GyozaConfig` still
 * works, it just gets `unknown` results throughout.
 */
export const defineConfig = <TPre extends Record<string, unknown> = Record<string, never>>(
  config: DefineConfigInput<TPre>,
): GyozaConfig => brand(config as GyozaConfig);

// ---------------------------------------------------------------------------
// Preflight validation and normalization
// ---------------------------------------------------------------------------

/** A step flattened out of either form, ready to run. */
export interface NormalizedStep {
  /** Where the return value lands in `ctx.results`. Absent for array-form steps. */
  key?: string;
  name: string;
  run(ctx: BuildContext): unknown;
}

export type StepForm = 'absent' | 'array' | 'object';

export const stepForm = (value: unknown): StepForm => {
  if (value === undefined || value === null) return 'absent';
  return Array.isArray(value) ? 'array' : 'object';
};

/**
 * Canonical array indices are hoisted and sorted numerically ahead of string keys
 * by JS property ordering, which would silently reorder steps. Every other string
 * key is insertion-ordered per spec, so declaration order is what runs.
 */
const isIntegerLikeKey = (key: string): boolean => /^(0|[1-9]\d*)$/.test(key);

export interface ConfigDiagnostics {
  errors: string[];
  warnings: string[];
}

const validateStepMap = (phase: 'pre' | 'post', map: BuildStepMap, errors: string[]): void => {
  for (const [key, entry] of Object.entries(map)) {
    if (isIntegerLikeKey(key)) {
      errors.push(
        `build.${phase} key "${key}" is a number. JavaScript sorts numeric keys ahead of every other key, ` +
          `so the step would not run in the order it is written. Rename it.`,
      );
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`build.${phase}.${key} must be an object with a run function.`);
      continue;
    }
    if (typeof entry.run !== 'function') {
      errors.push(`build.${phase}.${key}.run must be a function.`);
    }
  }
};

const validateStepArray = (phase: 'pre' | 'post', steps: unknown[], errors: string[]): void => {
  steps.forEach((step, i) => {
    if (typeof step !== 'object' || step === null) {
      errors.push(`build.${phase}[${i}] must be an object with a run function.`);
      return;
    }
    if (typeof (step as BuildStep).run !== 'function') {
      errors.push(`build.${phase}[${i}].run must be a function.`);
    }
  });
};

/**
 * Checks the build config before anything runs. Called ahead of the pre-build
 * checks so a malformed config costs nothing and can never leave a half-built
 * tree behind — the failure mode where pre steps run, a post step is invalid,
 * and `build/` is left in a broken state.
 */
export const validateBuildConfig = (config: GyozaConfig): ConfigDiagnostics => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const build = (config.build ?? {}) as RawBuildConfig;

  const preForm = stepForm(build.pre);
  const postForm = stepForm(build.post);

  if (preForm !== 'absent' && postForm !== 'absent' && preForm !== postForm) {
    errors.push(
      `build.pre uses the ${preForm} form but build.post uses the ${postForm} form. ` +
        `Migrate both to the keyed object form, or leave both as arrays.`,
    );
  }

  for (const [phase, value, form] of [
    ['pre', build.pre, preForm],
    ['post', build.post, postForm],
  ] as const) {
    if (form === 'object') validateStepMap(phase, value as BuildStepMap, errors);
    if (form === 'array') validateStepArray(phase, value as unknown[], errors);
  }

  const usesArrayForm =
    (preForm === 'array' && (build.pre as unknown[]).length > 0) ||
    (postForm === 'array' && (build.post as unknown[]).length > 0);
  const usesLegacySteps = (build.steps?.length ?? 0) > 0;
  const usesObjectForm = preForm === 'object' || postForm === 'object';

  if (usesLegacySteps) {
    warnings.push(
      'build.steps is deprecated. Move its entries into build.pre / build.post and drop the phase field.',
    );
  }
  if (usesArrayForm) {
    warnings.push(
      'build.pre / build.post as arrays is deprecated and will be removed. Use the keyed object form ' +
        'to give steps a stable identity and typed results — see docs/config.md.',
    );
  }
  // Only nag about defineConfig once the steps are already keyed — a config still on
  // the array form has been told to migrate, and that message covers this one.
  if (usesObjectForm && !usesArrayForm && !usesLegacySteps && !isDefinedConfig(config)) {
    warnings.push(
      'gyoza.config.ts does not use defineConfig(). Wrap the exported object in defineConfig() to get ' +
        'typed step results in build.post.',
    );
  }

  return { errors, warnings };
};

/**
 * Checks the `deploy` block before `gyoza deploy` touches anything, so a malformed
 * config fails before the working tree is pulled. Same `{ errors, warnings }` shape
 * as `validateBuildConfig`.
 */
export const validateDeployConfig = (config: GyozaConfig): ConfigDiagnostics => {
  const errors: string[] = [];
  const warnings: string[] = [];
  const deploy = config.deploy;

  if (deploy === undefined) return { errors, warnings };

  const { migrate, service } = deploy;

  if (migrate !== undefined && typeof migrate !== 'string' && typeof migrate !== 'function') {
    errors.push(
      'deploy.migrate must be a package.json script name (string) or a callback function. ' +
        `Got ${typeof migrate}.`,
    );
  }
  if (typeof migrate === 'string' && migrate.trim() === '') {
    errors.push('deploy.migrate is an empty string. Give it a package.json script name, or remove it.');
  }

  if (service !== undefined && typeof service !== 'string' && !Array.isArray(service)) {
    errors.push(`deploy.service must be a unit name (string) or an array of unit names. Got ${typeof service}.`);
  }
  if (typeof service === 'string' && service.trim() === '') {
    errors.push('deploy.service is an empty string. Give it a systemd unit name, or remove it.');
  }
  if (Array.isArray(service)) {
    if (service.length === 0) {
      errors.push('deploy.service is an empty array. List at least one systemd unit name, or remove it.');
    }
    service.forEach((unit, i) => {
      if (typeof unit !== 'string' || unit.trim() === '') {
        errors.push(`deploy.service[${i}] must be a non-empty unit name.`);
      }
    });
  }

  return { errors, warnings };
};

/**
 * Flattens either form into an ordered list. Object insertion order is preserved;
 * array-form and legacy steps keep their existing position after the keyed ones.
 */
export const normalizeSteps = (
  steps: BuildSteps | undefined,
  legacy: Omit<BuildStep, 'phase'>[] = [],
): NormalizedStep[] => {
  const own: NormalizedStep[] =
    stepForm(steps) === 'object'
      ? Object.entries(steps as BuildStepMap).map(([key, entry]) => ({
          key,
          name: entry.name ?? key,
          run: entry.run,
        }))
      : ((steps ?? []) as Omit<BuildStep, 'phase'>[]).map(step => ({ name: step.name, run: step.run }));

  return [...own, ...legacy.map(step => ({ name: step.name, run: step.run }))];
};

type RawBuildConfig = {
  pre?: BuildSteps;
  post?: BuildSteps;
  steps?: BuildStep[];
  cleanInstall?: boolean;
  typecheck?: TypeCheckLevel;
  lint?: LintCheckLevel;
};

const mergeConfig = (base: GyozaConfig, override: Partial<GyozaConfig>): GyozaConfig => {
  const b = base.build as RawBuildConfig | undefined;
  const o = override.build as RawBuildConfig | undefined;
  return {
    build: {
      cleanInstall: o?.cleanInstall ?? b?.cleanInstall ?? false,
      typecheck:    o?.typecheck    ?? b?.typecheck,
      lint:         o?.lint         ?? b?.lint,
      // Left undefined when absent rather than defaulted to [], so the preflight
      // can tell "no steps" apart from "empty array form" and not warn about the latter.
      pre:          o?.pre          ?? b?.pre,
      post:         o?.post         ?? b?.post,
      steps:        o?.steps        ?? b?.steps,
    },
    custom: override.custom ?? base.custom,
    deploy: override.deploy ?? base.deploy,
  };
};

export const loadConfig = async (projectRoot: string): Promise<GyozaConfig> => {
  const configPath = join(projectRoot, 'gyoza.config.ts');
  if (!existsSync(configPath)) return defaultConfig;

  try {
    const mod = await import(configPath);
    const userConfig: Partial<GyozaConfig> = mod.default ?? {};
    const merged = mergeConfig(defaultConfig, userConfig);
    // mergeConfig builds a fresh object, so the brand has to be carried across
    // from the raw default export before it is lost.
    return isDefinedConfig(mod.default) ? brand(merged) : merged;
  } catch (err) {
    console.warn(`  ⚠ Failed to load gyoza.config.ts: ${err instanceof Error ? err.message : String(err)}`);
    return defaultConfig;
  }
};
