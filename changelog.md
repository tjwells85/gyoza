# Changelog

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
