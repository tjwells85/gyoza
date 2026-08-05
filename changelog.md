# Changelog

## [0.6.1] - 2026-08-05

### Fixed

- `gyoza add --catalog` — catalogued the absolute latest version even when `[install] minimumReleaseAge` in `bunfig.toml` made it uninstallable, so the follow-up `bun install` failed outright with `No version matching "better-auth" found for specifier "^1.6.26" (blocked by minimum-release-age: 432000 seconds)`. `bun info` reports the latest regardless of the age gate, so the version has to be chosen up front rather than discovered at install time
  - The newest release at or below the resolved version whose publish time predates the cutoff is used instead, and the substitution is reported: `better-auth: using 1.6.25 instead of 1.6.26 — minimumReleaseAge (5 days) blocks newer releases`
  - The project's `bunfig.toml` is read first, falling back to `~/.bunfig.toml`; packages listed in `minimumReleaseAgeExcludes` bypass the gate, as does an unset or zero age, both without any registry call
  - Stability is preserved: a stable target never drops to a prerelease, and a dist-tag like `@next` stays within prereleases
  - When nothing is old enough, gyoza errors and names the `minimumReleaseAgeExcludes` escape hatch instead of cataloguing a version that cannot install
  - Explicit ranges are still stored verbatim — `better-auth@^1.6.26` writes what you asked for, and bun will reject it if nothing in that range is old enough. Omit the version to get the age-aware pick
- `compareVersions` now implements real semver prerelease ordering (numeric identifiers below alphanumeric, `rc.4` below `rc.10`, build metadata ignored). The previous version only compared release cores plus prerelease presence, which is not precise enough to select between prereleases. It moved from `src/commands/upgrade.ts` to `src/version.ts`, where both `gyoza upgrade` and the release-age gate use it

### Added

- Tests for the release-age gate and semver comparison (`tests/release-age.test.ts`), and for multiple packages in a single `gyoza add` / `gyoza remove` invocation — including a batch that mixes new, extended, and declined packages

---

## [0.6.0] - 2026-08-05

### Added

- `gyoza add` and `gyoza remove` — wrappers around `bun add` / `bun remove` that plug the gap where bun has no CLI affordance for writing to a workspace catalog (`bun add` has no `--catalog` flag and there is no `bun catalog` command). Without `--catalog` both commands are pure passthroughs to bun, argv untouched
  - `gyoza add --catalog server,frontend,shared date-fns` resolves the version, appends it to the root `catalog`, and writes `"date-fns": "catalog:"` into each named workspace, then runs a single `bun install`
  - Version specs are supported: `date-fns@beta` and `date-fns@^3.0.4` both work. Bare names and dist-tags are resolved via `bun info` and caret-ranged; explicit versions and ranges are stored verbatim, matching what `bun add pkg@^3.0.4` writes
  - Prereleases (`react@next`) are pinned exactly rather than caret-ranged — `^19.3.0-canary…` would match a stable release
  - Unknown dist-tags are an error. `bun info pkg@bogustag` silently falls back to `latest`, so the tag is validated against `bun info pkg dist-tags` first
  - Adding a package already in the catalog without a version extends it to the new workspaces and leaves the catalog version alone — the existing workspaces are never bumped
  - An explicit version that differs from the catalog entry prompts first, listing every workspace that references it, and defaults to no
  - `gyoza remove --catalog <ws> <pkg>` removes it from those workspaces and offers to prune the root catalog entry once no workspace references it (defaults to yes)
  - Flags: `--catalog <ws,...>` (also `--catalog=a,b`), `--dry`, `-y`/`--yes`, `-E`/`--exact`, `-d`/`--dev`, `--peer`, `--optional`. Workspace names are validated against the root `workspaces` array. Bun flags gyoza cannot honor in catalog mode (`-a`/`--analyze`, `--only-missing`) are rejected rather than silently dropped
- Unit tests for both commands (`tests/catalog-add.test.ts`, `tests/catalog-remove.test.ts`) covering spec parsing including scoped packages, version-vs-dist-tag classification, workspace discovery and validation, the extend-without-bump path, the version-clash prompt, orphan pruning, and section moves
- `gyoza upgrade` — updates gyoza itself and nothing else. Installed from git with no version range, gyoza is invisible to the normal update path in two separate ways: `bun install` will not move a git dependency whose spec is unchanged (the lockfile pins a commit and there is no range to re-satisfy), and `bun outdated` returns nothing at all for git dependencies, so gyoza can never appear in `gyoza update`'s report however far behind it is
  - Runs `bun update gyoza` from whichever `package.json` declares it — root first, then workspaces — and reports the version change by reading the installed `package.json` on either side
  - Prints the changelog entries between the old and new version, so it is immediately clear whether the upgrade changes behavior worth re-running
  - A spec carrying an explicit ref (`#main`, `#v0.5.0`, `#61cd181`) is reported rather than rejected: a branch tracks and moves, a tag or commit does not, and the two cannot be told apart without querying the remote. When nothing changes, the message says why
  - A pinned ref older than what is installed is reported as a **downgrade**, and the changelog section is suppressed in that direction
  - Exits 1 with a clear message when no `package.json` declares gyoza (e.g. running via `bunx`) or when gyoza is running from a source checkout rather than `node_modules`
- Unit tests for `gyoza upgrade` (`tests/upgrade.test.ts`) covering declaration lookup across root and workspaces, ref extraction, version comparison including prereleases and downgrades, and changelog range extraction

### Changed

- `gyoza update`'s description is now "Interactive updater for your project dependencies", to contrast with the neighbouring `gyoza upgrade`

### Fixed

- `gyoza help` — flag descriptions in the top-level command listing were sized from command-name lengths only, so any flag label longer than the widest command name ran straight into its description with no separating space

---

## [0.5.0] - 2026-07-23

### Fixed

- `gyoza update --latest` — packages pinned to an exact version (e.g. `"typescript": "6.0.3"`) were bumped to latest like any other package, since `--latest` ignores semver ranges entirely; a preflight scan now records exact-pinned versions across the root, `frontend/`, `server/`, and `shared/` `package.json` (including the root `catalog`) and restores them after `bun update` runs and catalog references are rewritten, before the final `bun install`

### Added

- `gyoza update --force` — bypasses pinned-version protection so exact-pinned packages update like any other
- `gyoza update` now prints a "Pinned versions (protected — pass --force to update anyway)" notice before prompting, showing each pinned package's current pin and the latest available version, when not using `--force`

---

## [0.4.1] - 2026-07-21

### Fixed

- `gyoza generate env` — server env.ts fields whose zod chain is wrapped onto multiple lines by Prettier (e.g. `KEY: z\n  .string()\n  .refine(...)`) were silently dropped: the field, its comments, and its directive never made it into the generated `.env` at all
  - `parseEnvTs` now tracks paren/brace depth across lines to find where a chained field declaration actually ends, instead of requiring `z.` on the same line as the key
  - `.default(...)` extraction now runs against the full joined multi-line chain instead of just the first line
- `validateGeneratedEnv` — the "is this key present" check used a plain substring match, so a field name that was a suffix of another key (e.g. `URL` vs `POSTGRES_URL`) could be masked as present when it was actually missing; the check is now anchored to the start of a line

### Added

- Unit tests for `gyoza generate env` (`tests/generate-env.test.ts`) covering both the server (`env.ts`) and frontend (`env.d.ts`) parsers: every directive (`@generate uuid/base64/alphanumeric`, `@pgurl`, `@mongourl`, `@mysqlurl`, `@apiurl`, `@placeholder`), multi-line chains, single- and multi-line JSDoc sections, directive-vs-default rendering precedence, and existing `.env` value overrides

---

## [0.4.0] - 2026-06-30

### Added

- `gyoza init scripts` — upserts canonical gyoza scripts in the project root `package.json` and removes legacy per-project script files
  - Upserts `build`, `update:all`, `update:latest`, `generate:env` — skips any that already call `gyoza` (assumed customised)
  - Removes script keys containing `'env'` that don't call `gyoza` (cleans up old aliases like `env:generate`, `prepare:env`)
  - Deletes `scripts/build.ts`, `scripts/prepare.ts`, `scripts/update.ts` if present; removes `scripts/` folder if it becomes empty
  - `--dry` flag prints a console preview without modifying any files
- `gyoza init eslint` — migrates `eslint.config.mts` → `eslint.config.mjs` across all workspaces (`./`, `frontend/`, `server/`, `shared/`)
  - Strips TypeScript-only `// @ts-*` directive lines (and inline trailing `// @ts-*` comments)
  - Injects `/** @type {import('eslint').Linter.Config[]} */` before `defineConfig(` calls
  - Skips directories where `.mjs` already exists, with a `⚠` warning
  - `--dry` flag writes `eslint-migration.md` to the project root with a preview of all four transformations without touching any files
  - After a normal migration, prompts to remove `eslint-migration.md` if it exists from a previous dry run

---

## [0.3.0] - 2026-06-09

### Added

- Custom scripts support via `custom` field in `gyoza.config.ts`
  - `custom.init` — register project-specific subcommands under `gyoza init`
  - `custom.generate` — register project-specific subcommands under `gyoza generate`
  - Scripts are plain functions: `{ [name]: () => void | Promise<void> }`
  - Built-in commands always take precedence; a warning is printed if a custom script name collides with a built-in
  - TypeScript collision guard: known command names resolve to `never` in the `CustomScripts` type, producing a compile error if a reserved name is used in the config
  - Known command types (`KnownInitCommand`, `KnownGenerateCommand`) are derived from the live registry objects — no manual list to maintain when new built-in commands are added
- `CustomScripts` type exported from the package root

### Changed

- `KnownInitCommand` and `KnownGenerateCommand` types are now derived from `keyof typeof initGroup.commands` / `keyof typeof generateGroup.commands` in their respective index files
- Documentation updated: README and CLAUDE.md reflect current package structure, command list, and the new custom scripts feature

---

## [0.2.0] - 2026-05-12

### Added

- Pre-build `typecheck` and `lint` checks in `gyoza.config.ts`
  - `typecheck?: 'off' | 'warn' | 'fail'` — runs `tsc --noEmit` before the build
  - `lint?: 'off' | 'warn' | 'fail' | { onError, onWarning }` — runs `eslint .` before the build
  - `'off'` skips the check (default), `'warn'` prints a summary and continues, `'fail'` aborts if issues are found
  - `lint` accepts an object form for independent control over ESLint errors vs warnings
  - Both checks run in parallel before the build directory is cleaned, so a failed check leaves the existing build intact

---

## [0.1.0] - 2026-05-08

### Added

- `gyoza generate env` — generates `server/.env` and `frontend/.env` from TypeScript env schema sources, with directive support (`@generate`, `@pgurl`, `@placeholder`, etc.) and safe backup/restore on validation failure
- `gyoza update` — interactive dependency updater; restores `catalog:` references after updating and re-runs `bun install`
  - `--latest` — ignore semver ranges, update to latest versions
  - `-y` / `--yes` — skip confirmation prompt
- `gyoza build` — production build pipeline (frontend via Bun workspace, server via `Bun.build`, assembled into `build/`)
  - Configurable via `gyoza.config.ts` with `pre` and `post` step hooks and optional `cleanInstall`
- `gyoza init config` — scaffolds a `gyoza.config.ts` in the project root
- Modular command group dispatch in `cli.ts`; commands organised under `generate` and `init` subgroups
- Typed `BuildConfig`, `BuildStep`, and `BuildContext` exported from `src/config.ts`
- Unit tests for `init config`

### Fixed

- Removed the `--elide-lines` flag from the Bun server bundler call (was producing truncated output)
