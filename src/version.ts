import { $ } from 'bun';
import { describeAge, noReleaseAgePolicy } from './bunfig.ts';
import type { ReleaseAgePolicy } from './bunfig.ts';

export interface PackageSpec {
  /** Package name, e.g. 'date-fns' or '@microsoft/microsoft-graph-client'. */
  name: string;
  /** Everything after the separating '@', or undefined when no version was given. */
  spec?: string;
}

/**
 * Split `name@version` on the last '@' at index > 0, so scoped packages
 * ('@scope/pkg@^1.0.0') parse correctly.
 */
export const parsePackageSpec = (input: string): PackageSpec => {
  const at = input.lastIndexOf('@');
  if (at <= 0) return { name: input };
  return { name: input.slice(0, at), spec: input.slice(at + 1) };
};

/**
 * A spec is a version or range (stored verbatim) rather than a dist-tag when it
 * starts with a digit or a range operator, is a bare wildcard, or joins ranges.
 *
 * Deliberately not a bare `x` substring test: 'next' contains an x.
 */
export const isVersionOrRange = (spec: string): boolean =>
  /^[\d^~><=v]/.test(spec) || spec === '*' || spec === 'x' || /\|\||\s-\s/.test(spec);

/** Prereleases carry a '-' after the version core, e.g. 5.0.0-alpha.0. */
export const isPrerelease = (version: string): boolean => /^\d+\.\d+\.\d+-/.test(version);

const splitVersion = (version: string): { core: string; pre: string } => {
  const plus = version.indexOf('+');
  const clean = plus === -1 ? version : version.slice(0, plus);
  const dash = clean.indexOf('-');
  return dash === -1 ? { core: clean, pre: '' } : { core: clean.slice(0, dash), pre: clean.slice(dash + 1) };
};

/** Semver prerelease ordering: numeric identifiers sort below alphanumeric ones. */
const comparePrerelease = (a: string, b: string): number => {
  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left.at(i);
    const y = right.at(i);
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);

    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }

    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }

  return 0;
};

/**
 * Compare two semver versions. Negative when `a` is older. Prereleases sort
 * below the release sharing their core, and below each other by identifier.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = splitVersion(a);
  const right = splitVersion(b);
  const leftCore = left.core.split('.');
  const rightCore = right.core.split('.');

  for (let i = 0; i < 3; i++) {
    const diff = (Number(leftCore.at(i)) || 0) - (Number(rightCore.at(i)) || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return comparePrerelease(left.pre, right.pre);
};

const bunInfo = async (arg: string, field: string): Promise<string> => {
  const out = (await $`bun info ${arg} ${field}`.nothrow().quiet().text()).trim();
  // A missing package prints a 404 to stderr and leaves stdout empty; the exit
  // code is not a reliable signal, so empty stdout is what we check.
  if (out === '') throw new Error(`Package "${arg}" not found in the registry.`);
  return out;
};

const getDistTags = async (name: string): Promise<Record<string, string>> => {
  const raw = await bunInfo(name, 'dist-tags');
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(`Could not read dist-tags for "${name}".`);
  }
};

/** Injectable so tests can exercise the age gate without hitting the registry. */
export type PublishTimesFetcher = (name: string) => Promise<Record<string, string>>;

export const getPublishTimes: PublishTimesFetcher = async (name) => {
  const raw = await bunInfo(name, 'time');
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    // 'created' and 'modified' are repository metadata, not versions.
    delete parsed.created;
    delete parsed.modified;
    return parsed;
  } catch {
    throw new Error(`Could not read publish times for "${name}".`);
  }
};

/** Injectable so tests can exercise range selection without hitting the registry. */
export type VersionsFetcher = (name: string) => Promise<string[]>;

/** Every published version of `name`, in the order npm returns them (oldest first). */
export const getPublishedVersions: VersionsFetcher = async (name) => {
  const raw = await bunInfo(name, 'versions');
  try {
    const parsed = JSON.parse(raw) as string[] | string;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(`Could not read published versions for "${name}".`);
  }
};

/**
 * The newest version at or below `upperBound` that is old enough to install.
 *
 * `bun info` always reports the absolute latest, which bun itself will then
 * refuse when `minimumReleaseAge` is set — so the version has to be chosen
 * here rather than discovered at install time.
 *
 * Stability is matched to the bound: resolving a stable target never drops to a
 * prerelease, and a prerelease target stays within prereleases.
 */
export const selectByReleaseAge = async (
  name: string,
  upperBound: string,
  policy: ReleaseAgePolicy,
  now: number = Date.now(),
  fetchTimes: PublishTimesFetcher = getPublishTimes,
): Promise<string> => {
  if (policy.minimumReleaseAge <= 0 || policy.excludes.includes(name)) return upperBound;

  const times = await fetchTimes(name);
  const cutoff = now - policy.minimumReleaseAge * 1000;
  const boundIsPrerelease = isPrerelease(upperBound);

  const eligible = Object.entries(times)
    .filter(([version]) => isPrerelease(version) === boundIsPrerelease)
    .filter(([version]) => compareVersions(version, upperBound) <= 0)
    .filter(([, published]) => Date.parse(published) <= cutoff)
    .map(([version]) => version)
    .sort(compareVersions);

  const newest = eligible.at(-1);

  if (newest === undefined) {
    throw new Error(
      `No version of "${name}" is old enough to install — minimumReleaseAge requires ${describeAge(policy.minimumReleaseAge)}.\n` +
        `  The newest available is ${upperBound}. Add "${name}" to minimumReleaseAgeExcludes in bunfig.toml to bypass the gate.`,
    );
  }

  return newest;
};

/**
 * Resolve a package spec to the value that should be written into the root catalog.
 *
 * - No spec / dist-tag  → resolved via `bun info`, prefixed with '^' unless exact or prerelease
 * - Version or range    → stored verbatim, matching what `bun add pkg@^3.0.4` writes
 *
 * Prereleases are always pinned exactly: `^5.0.0-alpha.0` would match a stable 5.0.0,
 * which is not what asking for `@next` means.
 *
 * `onNote` reports any version the release-age gate forced downwards.
 */
export const resolveCatalogVersion = async (
  { name, spec }: PackageSpec,
  exact = false,
  policy: ReleaseAgePolicy = noReleaseAgePolicy,
  onNote?: (note: string) => void,
): Promise<string> => {
  if (spec && isVersionOrRange(spec)) return spec;

  if (spec) {
    // `bun info pkg@bogustag` silently falls back to latest, so validate the tag first.
    const tags = await getDistTags(name);
    if (!(spec in tags)) {
      const known = Object.keys(tags).join(', ');
      throw new Error(`"${name}" has no dist-tag "${spec}". Known tags: ${known}`);
    }
  }

  const latest = await bunInfo(spec ? `${name}@${spec}` : name, 'version');
  const version = await selectByReleaseAge(name, latest, policy);

  if (version !== latest) {
    onNote?.(`${name}: using ${version} instead of ${latest} — minimumReleaseAge (${describeAge(policy.minimumReleaseAge)}) blocks newer releases`);
  }

  if (exact || isPrerelease(version)) return version;
  return `^${version}`;
};

/** The leading range operator of a catalog value, e.g. '^' from '^1.6.25'. '' when the value is an exact pin. */
export const rangeOperator = (range: string): string => {
  const match = /^(\^|~|>=|<=|>|<)/.exec(range.trim());
  return match ? match[1] : '';
};

/**
 * Resolve a catalog entry to the newest published, non-prerelease version that
 * still satisfies its current range, keeping the range's leading operator.
 * Returns undefined when nothing newer is in range.
 *
 * This is the `gyoza update` (no `--latest`) counterpart to `resolveCatalogVersion`:
 * a standard dependency moves to the newest in-range release, and so does the
 * catalog entry. The release-age gate is honored exactly as it is for `gyoza add`.
 */
export const resolveInRangeVersion = async (
  name: string,
  range: string,
  policy: ReleaseAgePolicy = noReleaseAgePolicy,
  onNote?: (note: string) => void,
  fetchVersions: VersionsFetcher = getPublishedVersions,
): Promise<string | undefined> => {
  const op = rangeOperator(range);

  const satisfying = (await fetchVersions(name))
    .filter((version) => !isPrerelease(version))
    .filter((version) => Bun.semver.satisfies(version, range))
    .sort((a, b) => Bun.semver.order(a, b));

  const newest = satisfying.at(-1);
  if (newest === undefined) return undefined;

  const picked = await selectByReleaseAge(name, newest, policy);
  if (picked !== newest) {
    onNote?.(
      `${name}: using ${picked} instead of ${newest} — minimumReleaseAge (${describeAge(policy.minimumReleaseAge)}) blocks newer releases`,
    );
  }

  return `${op}${picked}`;
};
