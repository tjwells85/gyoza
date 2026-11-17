import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckResult, PreflightCheckFn, PreflightContext } from './preflight.ts';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface MountEntry {
  mountPoint: string;
  fsType: string;
  source: string;
}

/** `\040` → space etc. — mountinfo octal-escapes whitespace and backslashes in paths. */
const decodeMountPath = (path: string): string =>
  path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));

/**
 * Parses `/proc/self/mountinfo`:
 * `36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw,errors=continue`
 * Optional fields vary in count, so fstype/source are read after the ` - ` separator.
 */
export const parseMountinfo = (text: string): MountEntry[] =>
  text
    .split('\n')
    .map((line) => {
      const [left, right] = line.split(' - ');
      const mountPoint = left?.split(' ')[4];
      const [fsType, source] = right?.split(' ') ?? [];
      return mountPoint && fsType ? { mountPoint: decodeMountPath(mountPoint), fsType, source: source ?? '' } : null;
    })
    .filter((entry): entry is MountEntry => entry !== null);

/** The last entry wins — a later mount over the same path hides the earlier one. */
export const findMount = (entries: MountEntry[], path: string): MountEntry | undefined =>
  entries.findLast((entry) => entry.mountPoint === path);

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kib: 1024,
  kb: 1000,
  m: 1024 ** 2,
  mib: 1024 ** 2,
  mb: 1000 ** 2,
  g: 1024 ** 3,
  gib: 1024 ** 3,
  gb: 1000 ** 3,
  t: 1024 ** 4,
  tib: 1024 ** 4,
  tb: 1000 ** 4,
};

/** `'20GB'` (decimal), `'20GiB'` / `'20G'` (binary, like `df -h`), `'1.5 TB'`, or a byte count. */
export const parseSize = (size: string | number): number => {
  if (typeof size === 'number') return size;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(size);
  const unit = SIZE_UNITS[(m?.[2] || 'b').toLowerCase()];
  if (!m || unit === undefined) throw new Error(`"${size}" is not a size — use e.g. '500MB', '20GB', '1.5TiB'.`);
  return Math.round(Number(m[1]) * unit);
};

export const formatBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
};

/** Second line of `df -B1 --output=avail <path>`. */
export const parseDfAvail = (stdout: string): number | undefined => {
  const value = stdout.trim().split('\n')[1]?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
};

/** PIDs from `ss -ltnpH` `users:(("bun",pid=1234,fd=12))`. Empty when the listener belongs to another user. */
export const findListenerPids = (ssOutput: string): number[] => [
  ...new Set([...ssOutput.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))),
];

/** The systemd unit a process runs under, from `/proc/<pid>/cgroup` (`0::/system.slice/app.service`). */
export const unitFromCgroup = (cgroup: string): string | undefined => {
  for (const line of cgroup.split('\n')) {
    const path = line.split(':').slice(2).join(':');
    const unit = path
      .split('/')
      .reverse()
      .find((segment) => segment.endsWith('.service'));
    if (unit) return unit;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

/**
 * `path` is a mount point (optionally of `fstype`). Reads `/proc/self/mountinfo`
 * and never touches the mount itself, so a hung NFS share can't block it.
 */
const mounted =
  (path: string, opts: { fstype?: string } = {}): PreflightCheckFn =>
  () => {
    const target = resolve(path);
    const info = readText('/proc/self/mountinfo');
    if (info === undefined) return { ok: false, detail: 'cannot read /proc/self/mountinfo' };
    const entry = findMount(parseMountinfo(info), target);
    if (!entry) return { ok: false, detail: `${target} is not a mount point` };
    if (opts.fstype && entry.fsType !== opts.fstype) {
      return { ok: false, detail: `${target} is ${entry.fsType}, expected ${opts.fstype}` };
    }
    return { ok: true, detail: `${target} (${entry.fsType} from ${entry.source})` };
  };

/**
 * At least `min` free at `path`. Runs `df` in a subprocess rather than calling
 * `statfs`: `statfs` on a dead hard-mounted NFS share blocks in the kernel and
 * would hang the deploy, while a subprocess can be abandoned at the timeout.
 */
const freeSpace =
  (path: string, min: string | number): PreflightCheckFn =>
  async (ctx: PreflightContext): Promise<CheckResult> => {
    // Parsed here, not in the factory: a throw while gyoza.config.ts is being
    // imported would make loadConfig fall back to the default config.
    const need = parseSize(min);
    const out = await ctx.exec(['df', '-B1', '--output=avail', path]);
    if (out.timedOut) return { ok: false, detail: `df ${path} timed out — is the mount hung?` };
    if (out.notFound) return { ok: false, detail: 'df not found' };
    const avail = parseDfAvail(out.stdout);
    if (out.exitCode !== 0 || avail === undefined) {
      return { ok: false, detail: `df ${path} failed: ${firstLine(out.stderr) || `exit ${out.exitCode}`}` };
    }
    const detail = `${formatBytes(avail)} free at ${path}, need ${formatBytes(need)}`;
    return { ok: avail >= need, detail };
  };

/**
 * Nothing *else* is listening on TCP `port`. The service being deployed is still
 * running and still holds its port, so a listener inside one of the `deploy.service`
 * units passes — otherwise this would fail every deploy.
 *
 * `ss` only shows PIDs for processes the deploy user owns (or all, as root). When
 * the listener is hidden and a `deploy.service` unit is active, it is assumed to be
 * that unit and the detail says so.
 */
const portFree =
  (port: number): PreflightCheckFn =>
  async (ctx) => {
    const out = await ctx.exec(['ss', '-ltnpH', `sport = :${port}`]);
    if (out.timedOut) return { ok: false, detail: 'ss timed out' };
    if (out.notFound) return { ok: false, detail: 'ss not found (install iproute2)' };
    if (out.exitCode !== 0) return { ok: false, detail: `ss failed: ${firstLine(out.stderr) || `exit ${out.exitCode}`}` };
    if (out.stdout.trim() === '') return { ok: true, detail: `port ${port} is free` };

    const pids = findListenerPids(out.stdout);
    if (pids.length > 0) {
      const foreign = pids.filter((pid) => {
        const unit = unitFromCgroup(readText(`/proc/${pid}/cgroup`) ?? '');
        return unit === undefined || !ctx.services.includes(unit);
      });
      if (foreign.length === 0) return { ok: true, detail: `port ${port} held by ${ctx.services.join(', ')} (restarting)` };
      const who = foreign.map((pid) => `${readText(`/proc/${pid}/comm`)?.trim() ?? '?'} (pid ${pid})`).join(', ');
      return { ok: false, detail: `port ${port} is in use by ${who}` };
    }

    for (const unit of ctx.services) {
      const state = await ctx.exec(['systemctl', 'is-active', unit]);
      if (state.stdout.trim() === 'active') {
        return { ok: true, detail: `port ${port} in use — assuming ${unit} (listener not visible to this user)` };
      }
    }
    return { ok: false, detail: `port ${port} is in use by a process this user cannot see` };
  };

/** `systemctl is-active <unit>` reports `active`. */
const serviceActive =
  (unit: string): PreflightCheckFn =>
  async (ctx) => {
    const out = await ctx.exec(['systemctl', 'is-active', unit]);
    if (out.timedOut) return { ok: false, detail: 'systemctl timed out' };
    if (out.notFound) return { ok: false, detail: 'systemctl not found' };
    const state = out.stdout.trim() || 'unknown';
    return { ok: state === 'active', detail: `${unit} is ${state}` };
  };

/** The command exits 0. A string runs through `sh -c`. */
const commandSucceeds =
  (cmd: string | string[], opts: { timeoutMs?: number } = {}): PreflightCheckFn =>
  async (ctx) => {
    const label = typeof cmd === 'string' ? cmd : cmd.join(' ');
    const out = await ctx.exec(cmd, opts);
    if (out.timedOut) return { ok: false, detail: `\`${label}\` timed out` };
    if (out.notFound) return { ok: false, detail: `\`${label}\`: command not found` };
    if (out.exitCode === 0) return { ok: true, detail: `\`${label}\` succeeded` };
    return { ok: false, detail: `\`${label}\` exited ${out.exitCode}: ${firstLine(out.stderr || out.stdout)}` };
  };

/** Built-in preflight checks for `deploy.preflight.checks`. */
export const check = { mounted, freeSpace, portFree, serviceActive, commandSucceeds };
