import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile, parseEnvTs } from './commands/generate/env.ts';
import { cleanEnvEntries, strictEnv } from './preflight.ts';
import type { ProjectEnv } from './preflight.ts';

/**
 * `.default()` values from `server/env.ts`. A field the app gets from its default
 * is commented out in `server/.env` (`# KEY=value`), so without these a check
 * would call it unset.
 */
const serverDefaults = (projectRoot: string): Record<string, string> => {
  const path = join(projectRoot, 'server/env.ts');
  if (!existsSync(path)) return {};
  const defaults: Record<string, string> = {};
  try {
    for (const field of parseEnvTs(readFileSync(path, 'utf-8'))) {
      if (field.kind === 'field' && field.defaultValue !== undefined) defaults[field.name] = field.defaultValue;
    }
  } catch {
    // An env.ts the parser can't read only costs the defaults, never the deploy.
  }
  return defaults;
};

/** `ctx.serverEnv` / `ctx.frontendEnv` for `deploy.preflight`. Read from disk on every call. */
export const loadProjectEnv = (projectRoot: string): { serverEnv: ProjectEnv; frontendEnv: ProjectEnv } => ({
  serverEnv: strictEnv(
    { ...serverDefaults(projectRoot), ...cleanEnvEntries(parseEnvFile(join(projectRoot, 'server/.env'))) },
    'server/.env',
  ),
  frontendEnv: strictEnv(cleanEnvEntries(parseEnvFile(join(projectRoot, 'frontend/.env'))), 'frontend/.env'),
});
