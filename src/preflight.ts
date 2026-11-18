import { existsSync } from 'node:fs';
import type { CheckAction, DeployMigrateContext } from './config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `true` / `false`, or an outcome carrying the measured value for the report line. */
export type CheckResult = boolean | { ok: boolean; detail?: string };

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** `null` when the process never finished (timed out) or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** The binary does not exist (array form), or `sh` exited 127 (string form). */
  notFound: boolean;
}

/**
 * Runs a command with a timeout. A string runs through `sh -c` (pipes, env
 * expansion); an array is spawned directly. Never throws for a failing command.
 */
export type PreflightExec = (cmd: string | string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/**
 * Values from a project `.env`. Reading an unset `UPPER_CASE` key **throws**
 * (`STORAGE_ROOT is not set in server/.env`), so a check fails with that message
 * rather than running against `undefined`. Test with `'KEY' in env` for optional keys.
 */
export type ProjectEnv = Readonly<Record<string, string>>;

export interface PreflightContext extends DeployMigrateContext {
  /** `deploy.service`, normalized to `.service` unit names. Empty when unset. */
  services: string[];
  exec: PreflightExec;
  /** `server/.env`, over the `.default()` values in `server/env.ts`. */
  serverEnv: ProjectEnv;
  /** `frontend/.env`. */
  frontendEnv: ProjectEnv;
}

/**
 * A check's result, or another check to run with the same context. The second
 * form is what lets a check read the env first:
 * `media: (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT)`.
 */
export type PreflightCheckReturn = CheckResult | PreflightCheckFn;

export type PreflightCheckFn = (ctx: PreflightContext) => PreflightCheckReturn | Promise<PreflightCheckReturn>;

export interface PreflightCheck {
  /** Label in the report. Defaults to the key. */
  name?: string;
  /** Throwing counts as a failure, with the error's message as the detail. */
  run: PreflightCheckFn;
  /** Default: `'fail'`. */
  onFail?: CheckAction;
}

/**
 * A semver range (`'>=15'`, `'>=7 <9'`), or an object to override how the
 * installed version is found.
 */
export type VersionSpec =
  | string
  | {
      range: string;
      /** Replaces the default probe. A string runs through `sh -c`. */
      probe?: string | string[];
      /**
       * Where the version sits in the probe output: a template with a `{version}`
       * marker (`'Build {version} ('`), or a RegExp whose first capture group is
       * the version. Default: the first `N.N[.N]` token in stdout + stderr.
       */
      match?: string | RegExp;
      /** Fallback: return the installed version yourself. `undefined` = could not tell. */
      get?: (ctx: PreflightContext) => string | undefined | Promise<string | undefined>;
    };

interface DepCommon {
  /** Label in the report. Defaults to the key. */
  name?: string;
  /** Applies to both "missing" and "wrong version". Default: `'fail'`. */
  onFail?: CheckAction;
  anyOf?: never;
}

/** A binary on PATH (or an absolute path). Default source: `command` = the key. Probe: `<command> --version`. */
export interface CommandDep extends DepCommon {
  command?: string;
  version?: VersionSpec;
  pkgConfig?: never;
  library?: never;
  exists?: never;
}

/** A library with a `.pc` file (needs the -dev/-devel package). Probe: `pkg-config --modversion`. */
export interface PkgConfigDep extends DepCommon {
  pkgConfig: string;
  version?: VersionSpec;
  command?: never;
  library?: never;
  exists?: never;
}

/** A shared library known to the dynamic linker (`ldconfig -p`). Presence only — no version. */
export interface LibraryDep extends DepCommon {
  library: string;
  version?: never;
  command?: never;
  pkgConfig?: never;
  exists?: never;
}

/** Custom presence test. A `version` needs `probe` or `get`, since there is nothing to derive one from. */
export interface ExistsDep extends DepCommon {
  exists: (ctx: PreflightContext) => boolean | Promise<boolean>;
  version?: VersionSpec;
  command?: never;
  pkgConfig?: never;
  library?: never;
}

export type SingleDep = CommandDep | PkgConfigDep | LibraryDep | ExistsDep;

/** An alternative inside `anyOf`. Only the group's `onFail` counts. */
export type DepAlternative = SingleDep & { onFail?: never };

/** Passes when any alternative passes, e.g. redis or valkey. */
export interface AnyOfDep {
  name?: string;
  onFail?: CheckAction;
  anyOf: Record<string, DepAlternative>;
}

export type PreflightDep = SingleDep | AnyOfDep;

export interface PreflightConfig {
  /** External software the project needs. Checked first, in declaration order. */
  deps?: Record<string, PreflightDep>;
  /** Server-state checks. A bare function is `{ run: fn, onFail: 'fail' }`. */
  checks?: Record<string, PreflightCheck | PreflightCheckFn>;
}

// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

/** Per-probe limit. A hung probe (dead NFS, wedged daemon) fails instead of hanging the deploy. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Per-check limit for `checks` entries, which may run several probes. */
export const CHECK_TIMEOUT_MS = 30_000;

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const TIMED_OUT = Symbol('timed out');

export const createExec =
  (cwd: string): PreflightExec =>
  async (cmd, opts = {}) => {
    const argv = typeof cmd === 'string' ? ['sh', '-c', cmd] : cmd;
    const spawn = () => {
      try {
        return Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      } catch {
        return undefined; // ENOENT is thrown synchronously
      }
    };
    const proc = spawn();
    if (!proc) return { stdout: '', stderr: '', exitCode: null, timedOut: false, notFound: true };

    const done = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    // Not awaited after a timeout: a process stuck in the kernel (D state) may
    // never die, and the deploy must not wait on it.
    const result = await withTimeout(done, opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    if (result === TIMED_OUT) {
      proc.kill('SIGKILL');
      return { stdout: '', stderr: '', exitCode: null, timedOut: true, notFound: false };
    }

    const [stdout, stderr, exitCode] = result;
    return { stdout, stderr, exitCode, timedOut: false, notFound: typeof cmd === 'string' && exitCode === 127 };
  };

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Without a template, a version needs at least one dot so stray numbers (`bits=64`) don't match. */
const DEFAULT_VERSION = /\d+(?:\.\d+){1,3}/;
const TEMPLATE_VERSION = String.raw`\d+(?:\.\d+){0,3}`;
export const VERSION_MARKER = '{version}';

/**
 * Pull a version out of probe output. Distro suffixes (`6.1.1-3ubuntu5`) are
 * left off on purpose: semver would read them as prereleases and fail `>=6`.
 */
export const extractVersion = (output: string, match?: string | RegExp): string | undefined => {
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    const m = match.exec(output);
    return m ? (m[1] ?? m[0]) : undefined;
  }
  if (typeof match === 'string') {
    const at = match.indexOf(VERSION_MARKER);
    if (at === -1) return undefined;
    const literal = (text: string): string => escapeRegExp(text).replace(/\s+/g, String.raw`\s+`);
    const re = new RegExp(
      literal(match.slice(0, at)) + `(${TEMPLATE_VERSION})` + literal(match.slice(at + VERSION_MARKER.length)),
    );
    return re.exec(output)?.[1];
  }
  return DEFAULT_VERSION.exec(output)?.[0];
};

/** `16.4` → `16.4.0`, `v1.2.3.4` → `1.2.3`. `Bun.semver.satisfies` rejects partial versions. */
export const coerceVersion = (version: string): string | undefined => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim());
  if (!m) return undefined;
  return [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number).join('.');
};

const PART = String.raw`(?:\d+|[xX*])`;
const VER = String.raw`v?${PART}(?:\.${PART}){0,2}(?:-[0-9A-Za-z.-]+)?`;
const COMPARATOR = String.raw`(?:[\^~]|[<>]=?|=)?\s*${VER}`;
const HYPHEN = String.raw`${VER}\s+-\s+${VER}`;
const SET = String.raw`(?:${HYPHEN}|${COMPARATOR}(?:\s+${COMPARATOR})*)`;
const RANGE = new RegExp(String.raw`^\s*${SET}(?:\s*\|\|\s*${SET})*\s*$`);

/**
 * `Bun.semver.satisfies(v, 'garbage')` returns **true**, so a typo'd range would
 * silently pass every check. Ranges are validated against the grammar here instead.
 */
export const isValidRange = (range: string): boolean => RANGE.test(range);

export const satisfiesRange = (version: string, range: string): boolean => {
  const coerced = coerceVersion(version);
  return coerced !== undefined && Bun.semver.satisfies(coerced, range);
};

// ---------------------------------------------------------------------------
// Project env
// ---------------------------------------------------------------------------

/**
 * `parseEnvFile` keeps values exactly as written, which `generate env` needs to
 * write them back. A check needs the value the app sees: no `export ` prefix, no
 * surrounding quotes, no trailing ` # comment` on an unquoted value.
 */
export const cleanEnvEntries = (raw: Record<string, string>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = rawKey.replace(/^export\s+/, '').trim();
    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[key] = value;
  }
  return env;
};

/** Env-var-shaped keys only. Inspection keys (`then`, `toJSON`, …) read as normal. */
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

/** See {@link ProjectEnv}: reading an unset env key throws, naming `source`. */
export const strictEnv = (values: Record<string, string>, source: string): ProjectEnv =>
  new Proxy(Object.freeze({ ...values }), {
    get(target, key, receiver) {
      if (typeof key === 'string' && ENV_KEY.test(key) && !(key in target)) {
        throw new Error(`${key} is not set in ${source}`);
      }
      return Reflect.get(target, key, receiver);
    },
  });

// ---------------------------------------------------------------------------
// Libraries
// ---------------------------------------------------------------------------

/** First soname in `ldconfig -p` output for `vips` / `libvips` / `libvips.so.42`. `libvips-cpp` is not `libvips`. */
export const findLibrary = (ldconfigOutput: string, name: string): string | undefined => {
  const base = name.startsWith('lib') ? name : `lib${name}`;
  for (const line of ldconfigOutput.split('\n')) {
    const token = line.trim().split(/\s/)[0] ?? '';
    const hit = base.includes('.so')
      ? token === base || token.startsWith(`${base}.`)
      : token === `${base}.so` || token.startsWith(`${base}.so.`);
    if (hit) return token;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PreflightOutcome {
  label: string;
  ok: boolean;
  detail: string;
  onFail: CheckAction;
}

/** Host lookups, injectable so tests never touch the real system. */
export interface PreflightEnv {
  which: (cmd: string) => string | null;
}

export const defaultEnv: PreflightEnv = {
  which: (cmd) => (cmd.includes('/') ? (existsSync(cmd) ? cmd : null) : Bun.which(cmd)),
};

interface DepResult {
  ok: boolean;
  detail: string;
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';

const describeCmd = (cmd: string | string[]): string => (typeof cmd === 'string' ? cmd : cmd.join(' '));

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Presence of a single dep. `probe` is the default version probe for that source, if it has one. */
const locateDep = async (
  key: string,
  dep: SingleDep,
  ctx: PreflightContext,
  env: PreflightEnv,
): Promise<{ found: false; detail: string } | { found: true; detail: string; probe?: string[] }> => {
  if (dep.exists !== undefined) {
    return (await dep.exists(ctx)) ? { found: true, detail: 'present' } : { found: false, detail: 'not found' };
  }

  if (dep.library !== undefined) {
    const ldconfig = env.which('ldconfig') ?? ['/sbin/ldconfig', '/usr/sbin/ldconfig'].find((p) => env.which(p));
    if (!ldconfig) return { found: false, detail: 'ldconfig not found — cannot look up shared libraries' };
    const out = await ctx.exec([ldconfig, '-p']);
    if (out.timedOut) return { found: false, detail: 'ldconfig -p timed out' };
    const soname = findLibrary(out.stdout, dep.library);
    return soname ? { found: true, detail: soname } : { found: false, detail: `${dep.library} not found (ldconfig -p)` };
  }

  if (dep.pkgConfig !== undefined) {
    const pkgConfig = env.which('pkg-config');
    if (!pkgConfig) return { found: false, detail: 'pkg-config is not installed' };
    const out = await ctx.exec([pkgConfig, '--exists', dep.pkgConfig]);
    if (out.timedOut) return { found: false, detail: 'pkg-config timed out' };
    return out.exitCode === 0
      ? { found: true, detail: 'installed', probe: [pkgConfig, '--modversion', dep.pkgConfig] }
      : { found: false, detail: `not found (pkg-config ${dep.pkgConfig} — needs the -dev/-devel package)` };
  }

  const command = dep.command ?? key;
  const path = env.which(command);
  return path
    ? { found: true, detail: path, probe: [path, '--version'] }
    : { found: false, detail: `${command} not found on PATH` };
};

const evaluateSingleDep = async (
  key: string,
  dep: SingleDep,
  ctx: PreflightContext,
  env: PreflightEnv,
): Promise<DepResult> => {
  const located = await locateDep(key, dep, ctx, env);
  if (!located.found || dep.version === undefined) return { ok: located.found, detail: located.detail };

  const spec = typeof dep.version === 'string' ? { range: dep.version } : dep.version;

  let version: string | undefined;
  if (spec.get) {
    version = await spec.get(ctx);
    if (version === undefined) return { ok: false, detail: 'version.get() could not determine a version' };
  } else {
    const probe = spec.probe ?? located.probe;
    if (!probe) return { ok: false, detail: 'no version probe — set version.probe or version.get' };
    const out = await ctx.exec(probe);
    if (out.timedOut) return { ok: false, detail: `\`${describeCmd(probe)}\` timed out` };
    if (out.notFound) return { ok: false, detail: `\`${describeCmd(probe)}\`: command not found` };
    const output = `${out.stdout}\n${out.stderr}`;
    version = extractVersion(output, spec.match);
    if (version === undefined) {
      const why = out.exitCode === 0 ? 'no version in output' : `exit ${out.exitCode}`;
      return { ok: false, detail: `\`${describeCmd(probe)}\`: ${why} — ${firstLine(output) || '(no output)'}` };
    }
  }

  return satisfiesRange(version, spec.range)
    ? { ok: true, detail: `${version} (${spec.range})` }
    : { ok: false, detail: `${version}, need ${spec.range}` };
};

const evaluateDep = async (
  key: string,
  dep: PreflightDep,
  ctx: PreflightContext,
  env: PreflightEnv,
): Promise<DepResult> => {
  if (dep.anyOf === undefined) return evaluateSingleDep(key, dep, ctx, env);

  const alternatives = Object.entries(dep.anyOf);
  const names = alternatives.map(([altKey, alt]) => alt.name ?? altKey).join(', ');
  const misses: string[] = [];

  for (const [altKey, alt] of alternatives) {
    const label = alt.name ?? altKey;
    const result = await guard(() => evaluateSingleDep(altKey, alt, ctx, env));
    if (result.ok) return { ok: true, detail: `${label} ${result.detail} — one of ${names}` };
    misses.push(`${label}: ${result.detail}`);
  }

  return { ok: false, detail: `none of ${names} — ${misses.join('; ')}` };
};

/** A throw or a hang is a failed check, never a crashed deploy. */
const guard = async (work: () => DepResult | Promise<DepResult>, ms = CHECK_TIMEOUT_MS): Promise<DepResult> => {
  try {
    const result = await withTimeout(Promise.resolve().then(work), ms);
    return result === TIMED_OUT ? { ok: false, detail: `timed out after ${ms / 1000}s` } : result;
  } catch (err) {
    return { ok: false, detail: errorMessage(err) };
  }
};

const normalizeCheckResult = (result: unknown): DepResult => {
  if (typeof result === 'function') {
    return { ok: false, detail: 'returned a check that returned another check — return a result or one check' };
  }
  if (typeof result === 'boolean') return { ok: result, detail: result ? 'ok' : 'failed' };
  if (typeof result === 'object' && result !== null && typeof (result as { ok?: unknown }).ok === 'boolean') {
    const { ok, detail } = result as { ok: boolean; detail?: unknown };
    return { ok, detail: typeof detail === 'string' && detail !== '' ? detail : ok ? 'ok' : 'failed' };
  }
  return { ok: false, detail: `returned ${JSON.stringify(result) ?? String(result)} — expected a boolean or { ok }` };
};

/** Every dep, then every check, in declaration order. Everything runs — one pass reports every problem. */
export const evaluatePreflight = async (
  config: PreflightConfig,
  ctx: PreflightContext,
  env: PreflightEnv = defaultEnv,
): Promise<PreflightOutcome[]> => {
  const outcomes: PreflightOutcome[] = [];

  for (const [key, dep] of Object.entries(config.deps ?? {})) {
    const result = await guard(() => evaluateDep(key, dep, ctx, env));
    outcomes.push({ label: dep.name ?? key, onFail: dep.onFail ?? 'fail', ...result });
  }

  for (const [key, entry] of Object.entries(config.checks ?? {})) {
    const check = typeof entry === 'function' ? { run: entry } : entry;
    const result = await guard(async () => {
      const first = await check.run(ctx);
      // One level only: a check that returns a check is a factory call, deeper is a mistake.
      return normalizeCheckResult(typeof first === 'function' ? await first(ctx) : first);
    });
    outcomes.push({ label: check.name ?? key, onFail: check.onFail ?? 'fail', ...result });
  }

  return outcomes;
};

export const hasPreflight = (config: PreflightConfig | undefined): config is PreflightConfig =>
  config !== undefined && Object.keys(config.deps ?? {}).length + Object.keys(config.checks ?? {}).length > 0;

export interface PreflightSummary {
  failed: number;
  warned: number;
}

/** ✓ lines to stdout, ⚠ via console.warn, ✗ via console.error. */
export const reportPreflight = (outcomes: PreflightOutcome[]): PreflightSummary => {
  const width = Math.max(0, ...outcomes.map((o) => o.label.length));
  let failed = 0;
  let warned = 0;

  for (const { label, ok, detail, onFail } of outcomes) {
    const line = `${label.padEnd(width)}  ${detail}`;
    if (ok) console.log(`  ✓ ${line}`);
    else if (onFail === 'warn') {
      warned++;
      console.warn(`  ⚠ ${line}`);
    } else {
      failed++;
      console.error(`  ✗ ${line}`);
    }
  }

  return { failed, warned };
};

export const runPreflight = async (
  config: PreflightConfig,
  ctx: PreflightContext,
  env: PreflightEnv = defaultEnv,
): Promise<PreflightSummary> => reportPreflight(await evaluatePreflight(config, ctx, env));

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CHECK_ACTIONS: readonly CheckAction[] = ['warn', 'fail'];
const DEP_SOURCES = ['command', 'pkgConfig', 'library', 'exists'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validateOnFail = (path: string, value: unknown, errors: string[]): void => {
  if (value !== undefined && !CHECK_ACTIONS.includes(value as CheckAction)) {
    errors.push(`${path}.onFail must be 'warn' or 'fail'. Got ${JSON.stringify(value)}.`);
  }
};

const validateName = (path: string, value: unknown, errors: string[]): void => {
  if (value !== undefined && typeof value !== 'string') errors.push(`${path}.name must be a string.`);
};

const validateRange = (path: string, range: unknown, errors: string[]): void => {
  if (typeof range !== 'string' || !isValidRange(range)) {
    errors.push(`${path} must be a semver range like '>=15' or '>=7 <9'. Got ${JSON.stringify(range)}.`);
  }
};

const validateVersion = (path: string, version: unknown, hasDefaultProbe: boolean, errors: string[]): void => {
  if (typeof version === 'string') {
    validateRange(path, version, errors);
    if (!hasDefaultProbe) errors.push(`${path} has no default probe for this source — use { range, probe } or { range, get }.`);
    return;
  }
  if (!isRecord(version)) {
    errors.push(`${path} must be a range string or { range, probe?, match?, get? }.`);
    return;
  }

  validateRange(`${path}.range`, version.range, errors);

  const { probe, match, get } = version;
  if (probe !== undefined) {
    const validProbe =
      (typeof probe === 'string' && probe.trim() !== '') ||
      (Array.isArray(probe) && probe.length > 0 && probe.every((p) => typeof p === 'string' && p !== ''));
    if (!validProbe) errors.push(`${path}.probe must be a non-empty command string or string array.`);
  }
  if (match !== undefined && !(match instanceof RegExp)) {
    if (typeof match !== 'string' || !match.includes(VERSION_MARKER)) {
      errors.push(`${path}.match must be a RegExp or a template containing ${VERSION_MARKER}.`);
    }
  }
  if (get !== undefined && typeof get !== 'function') errors.push(`${path}.get must be a function.`);
  if (get === undefined && probe === undefined && !hasDefaultProbe) {
    errors.push(`${path} has no default probe for this source — set version.probe or version.get.`);
  }
};

const validateSingleDep = (path: string, dep: Record<string, unknown>, errors: string[]): void => {
  const sources = DEP_SOURCES.filter((s) => dep[s] !== undefined);
  if (sources.length > 1) {
    errors.push(`${path} sets ${sources.join(' and ')} — pick one source.`);
    return;
  }
  const source = sources[0] ?? 'command';

  if (source === 'exists') {
    if (typeof dep.exists !== 'function') errors.push(`${path}.exists must be a function.`);
  } else if (dep[source] !== undefined && (typeof dep[source] !== 'string' || (dep[source] as string).trim() === '')) {
    errors.push(`${path}.${source} must be a non-empty string.`);
  }

  if (dep.version === undefined) return;
  if (source === 'library') {
    errors.push(`${path}: library deps are presence-only — use pkgConfig to check a version.`);
    return;
  }
  validateVersion(`${path}.version`, dep.version, source === 'command' || source === 'pkgConfig', errors);
};

/** Shape checks for `deploy.preflight`, run with the rest of `validateDeployConfig`. */
export const validatePreflightConfig = (preflight: unknown, errors: string[]): void => {
  const root = 'deploy.preflight';
  if (preflight === undefined) return;
  if (!isRecord(preflight)) {
    errors.push(`${root} must be an object with deps and/or checks.`);
    return;
  }

  const { deps, checks } = preflight;

  if (deps !== undefined && !isRecord(deps)) errors.push(`${root}.deps must be an object keyed by dependency.`);
  if (isRecord(deps)) {
    for (const [key, dep] of Object.entries(deps)) {
      const path = `${root}.deps.${key}`;
      if (!isRecord(dep)) {
        errors.push(`${path} must be an object.`);
        continue;
      }
      validateName(path, dep.name, errors);
      validateOnFail(path, dep.onFail, errors);

      if (dep.anyOf === undefined) {
        validateSingleDep(path, dep, errors);
        continue;
      }
      if (!isRecord(dep.anyOf) || Object.keys(dep.anyOf).length === 0) {
        errors.push(`${path}.anyOf must be an object with at least one alternative.`);
        continue;
      }
      const stray: string[] = [...DEP_SOURCES, 'version'].filter((s) => dep[s] !== undefined);
      if (stray.length > 0) errors.push(`${path} sets ${stray.join(', ')} alongside anyOf — move them into an alternative.`);

      for (const [altKey, alt] of Object.entries(dep.anyOf)) {
        const altPath = `${path}.anyOf.${altKey}`;
        if (!isRecord(alt)) {
          errors.push(`${altPath} must be an object.`);
          continue;
        }
        if (alt.anyOf !== undefined) errors.push(`${altPath}: anyOf cannot be nested.`);
        if (alt.onFail !== undefined) errors.push(`${altPath}.onFail is ignored inside anyOf — set it on ${path}.`);
        validateName(altPath, alt.name, errors);
        validateSingleDep(altPath, alt, errors);
      }
    }
  }

  if (checks !== undefined && !isRecord(checks)) errors.push(`${root}.checks must be an object keyed by check.`);
  if (isRecord(checks)) {
    for (const [key, check] of Object.entries(checks)) {
      const path = `${root}.checks.${key}`;
      if (typeof check === 'function') continue;
      if (!isRecord(check) || typeof check.run !== 'function') {
        errors.push(`${path} must be a function or { run: function }.`);
        continue;
      }
      validateName(path, check.name, errors);
      validateOnFail(path, check.onFail, errors);
    }
  }
};
