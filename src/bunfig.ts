import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `[install] minimumReleaseAge` from bunfig.toml — bun refuses to install any
 * version published more recently than this, so gyoza must not catalog one.
 */
export interface ReleaseAgePolicy {
  /** Seconds. 0 means no age gate. */
  minimumReleaseAge: number;
  /** Package names exempt from the gate. */
  excludes: string[];
}

export const noReleaseAgePolicy: ReleaseAgePolicy = { minimumReleaseAge: 0, excludes: [] };

interface BunfigInstall {
  minimumReleaseAge?: number;
  minimumReleaseAgeExcludes?: string[];
}

// Bun parses .toml natively, so a dynamic import is the whole parser.
const readBunfig = async (path: string): Promise<BunfigInstall | undefined> => {
  if (!existsSync(path)) return undefined;

  try {
    const mod = await import(path);
    return (mod.default?.install ?? undefined) as BunfigInstall | undefined;
  } catch (err) {
    console.warn(`  ⚠ Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
};

/**
 * Resolve the effective policy the way bun does: the global `~/.bunfig.toml`
 * first, then the project's `bunfig.toml` overriding it key by key.
 */
export const readReleaseAgePolicy = async (cwd: string): Promise<ReleaseAgePolicy> => {
  const global = await readBunfig(join(homedir(), '.bunfig.toml'));
  const local = await readBunfig(join(cwd, 'bunfig.toml'));

  return {
    minimumReleaseAge: local?.minimumReleaseAge ?? global?.minimumReleaseAge ?? 0,
    excludes: local?.minimumReleaseAgeExcludes ?? global?.minimumReleaseAgeExcludes ?? [],
  };
};

export const describeAge = (seconds: number): string => {
  const days = seconds / 86400;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = seconds / 3600;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${seconds} seconds`;
};
