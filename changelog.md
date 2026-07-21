# Changelog

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
