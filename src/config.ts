import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildContext {
  projectRoot: string;
  buildDir: string;
}

export interface BuildStep {
  name: string;
  /**
   * @deprecated Use the top-level `build.pre` or `build.post` arrays instead.
   * 'pre' runs after clean, before frontend/server build. 'post' runs after assembly. Defaults to 'post'.
   */
  phase?: 'pre' | 'post';
  run(ctx: BuildContext): Promise<void>;
}

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

export interface BuildConfig {
  /** Remove all node_modules recursively before building, then run `bun install`. Default: false. */
  cleanInstall?: boolean;
  /** Run `tsc --noEmit` before the build. Default: 'off'. */
  typecheck?: TypeCheckLevel;
  /** Run `eslint .` before the build. Default: 'off'. */
  lint?: LintCheckLevel;
  /** Steps to run after clean, before the frontend/server build. */
  pre?: Omit<BuildStep, 'phase'>[];
  /** Steps to run after assembly. */
  post?: Omit<BuildStep, 'phase'>[];
  /**
   * @deprecated Use `pre` and `post` arrays instead.
   * Supported for backward compatibility — steps are routed by their `phase` field.
   */
  steps?: BuildStep[];
}

export interface CustomScripts {
  init?: Record<string, () => void | Promise<void>>;
  generate?: Record<string, () => void | Promise<void>>;
}

export interface GyozaConfig {
  build?: BuildConfig;
  custom?: CustomScripts;
}

export const defaultConfig: GyozaConfig = {
  build: {
    cleanInstall: false,
    pre: [],
    post: [],
    steps: [],
  },
};

type RawBuildConfig = {
  pre?: Omit<BuildStep, 'phase'>[];
  post?: Omit<BuildStep, 'phase'>[];
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
      pre:          o?.pre          ?? b?.pre   ?? [],
      post:         o?.post         ?? b?.post  ?? [],
      steps:        o?.steps        ?? b?.steps ?? [],
    },
    custom: override.custom ?? base.custom,
  };
};

export const loadConfig = async (projectRoot: string): Promise<GyozaConfig> => {
  const configPath = join(projectRoot, 'gyoza.config.ts');
  if (!existsSync(configPath)) return defaultConfig;

  try {
    const mod = await import(configPath);
    const userConfig: Partial<GyozaConfig> = mod.default ?? {};
    return mergeConfig(defaultConfig, userConfig);
  } catch (err) {
    console.warn(`  ⚠ Failed to load gyoza.config.ts: ${err instanceof Error ? err.message : String(err)}`);
    return defaultConfig;
  }
};
