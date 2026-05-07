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

export interface BuildConfig {
  /** Remove all node_modules recursively before building, then run `bun install`. Default: false. */
  cleanInstall?: boolean;
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

export interface GyozaConfig {
  build?: BuildConfig;
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
};

const mergeConfig = (base: GyozaConfig, override: Partial<GyozaConfig>): GyozaConfig => {
  const b = base.build as RawBuildConfig | undefined;
  const o = override.build as RawBuildConfig | undefined;
  return {
    build: {
      cleanInstall: o?.cleanInstall ?? b?.cleanInstall ?? false,
      pre:   o?.pre   ?? b?.pre   ?? [],
      post:  o?.post  ?? b?.post  ?? [],
      steps: o?.steps ?? b?.steps ?? [],
    },
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
