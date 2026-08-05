import { $ } from 'bun';

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

/**
 * Resolve a package spec to the value that should be written into the root catalog.
 *
 * - No spec / dist-tag  → resolved via `bun info`, prefixed with '^' unless exact or prerelease
 * - Version or range    → stored verbatim, matching what `bun add pkg@^3.0.4` writes
 *
 * Prereleases are always pinned exactly: `^5.0.0-alpha.0` would match a stable 5.0.0,
 * which is not what asking for `@next` means.
 */
export const resolveCatalogVersion = async ({ name, spec }: PackageSpec, exact = false): Promise<string> => {
  if (spec && isVersionOrRange(spec)) return spec;

  if (spec) {
    // `bun info pkg@bogustag` silently falls back to latest, so validate the tag first.
    const tags = await getDistTags(name);
    if (!(spec in tags)) {
      const known = Object.keys(tags).join(', ');
      throw new Error(`"${name}" has no dist-tag "${spec}". Known tags: ${known}`);
    }
  }

  const version = await bunInfo(spec ? `${name}@${spec}` : name, 'version');
  if (exact || isPrerelease(version)) return version;
  return `^${version}`;
};
