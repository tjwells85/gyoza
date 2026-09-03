# CLAUDE.md — Gyoza

> **CRITICAL: Any time `version` in `package.json` is incremented, `changelog.md` MUST be updated in the same commit with a new version entry covering every change since the previous release. Never bump the version without updating the changelog.**

## What Is This

**Gyoza** is a private CLI tooling package for projects scaffolded from the
`hono-react-template` (a fullstack Bun + Hono + React monorepo template). It
extracts the maintenance scripts from that template into a versioned,
independently-updatable package so that all downstream projects get bug fixes
and improvements via a single `bun update`.

The name is intentional: Hono means "flame" in Japanese, Bun's mascot is a
bao, and gyoza are pan-fried dumplings — fire + bao.

---

## Background and Motivation

The source template (`hono-react-template`) ships with scripts inside a
`scripts/` folder: `generate.ts`, `update.ts`, `build.ts`, `migrate.ts`. As
the template evolves, the ~12 existing projects using it can't receive those
improvements without manual copy-paste. Gyoza fixes that by making the scripts
a proper dependency.

---

## Architecture

### Runtime

Bun only. Bun executes TypeScript directly — no build step, no compilation.
The `bin` entry in `package.json` points straight at `cli.ts`.

### Package structure

```
gyoza/
├── CLAUDE.md
├── changelog.md
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc.mjs
├── cli.ts                  ← bin entry point, tree-walking dispatcher
├── index.ts                ← public type exports
└── src/
    ├── config.ts           ← GyozaConfig, defineConfig, loadConfig, build-config preflight
    ├── gyoza.ts            ← Command/CommandGroup types, registry builder
    ├── workspaces.ts       ← workspace discovery, catalog read/write helpers
    ├── catalog.ts          ← catalog-mode arg parsing, change application
    ├── bunfig.ts           ← bunfig.toml minimumReleaseAge policy
    ├── version.ts          ← bun info resolution, semver compare, release-age gate
    ├── prompt.ts           ← shared Y/n confirmation
    └── commands/
        ├── index.ts        ← registry root (assembles all groups)
        ├── build.ts        ← gyoza build
        ├── deploy.ts       ← gyoza deploy
        ├── add.ts          ← gyoza add
        ├── remove.ts       ← gyoza remove
        ├── update.ts       ← gyoza update
        ├── upgrade.ts      ← gyoza upgrade (self-update)
        ├── generate/
        │   ├── index.ts    ← generateGroup + KnownGenerateCommand type
        │   └── env.ts      ← gyoza generate env
        └── init/
            ├── index.ts    ← initGroup + KnownInitCommand type
            ├── config.ts   ← gyoza init config
            ├── eslint.ts   ← gyoza init eslint
            └── scripts.ts  ← gyoza init scripts
```

No CLI framework (no commander, yargs, etc.). `cli.ts` tree-walks a
`CommandGroup` registry; each leaf is a `Command` with a `run` handler.

### CLI commands

| Invocation                  | What it does                                                |
|-----------------------------|-------------------------------------------------------------|
| `gyoza generate env`        | Generate/update `.env` files from schema sources            |
| `gyoza init config`         | Scaffold or migrate `gyoza.config.ts`                       |
| `gyoza init eslint`         | Migrate `eslint.config.mts` → `.mjs` in all workspaces     |
| `gyoza init eslint --dry`   | Preview migration output in `eslint-migration.md`           |
| `gyoza init scripts`        | Upsert gyoza scripts in `package.json`, remove legacy files |
| `gyoza init scripts --dry`  | Preview script changes in the console without applying them |
| `gyoza add <args>`          | Passthrough to `bun add`                                    |
| `gyoza add --catalog <ws>`  | Add to the root catalog, reference it from `<ws>`           |
| `gyoza remove <args>`       | Passthrough to `bun remove`                                 |
| `gyoza remove --catalog <ws>` | Remove from `<ws>`, prune the catalog entry if orphaned    |
| `gyoza update`              | Interactive dependency updater                              |
| `gyoza update --latest`     | Update to latest versions (ignores semver range)            |
| `gyoza update -y`           | Skip confirmation prompt                                    |
| `gyoza update --force`      | Also update packages pinned to an exact version              |
| `gyoza upgrade`             | Update gyoza itself from its git remote                     |
| `gyoza build`               | Build the project                                           |
| `gyoza deploy`              | Pull, install, migrate, build, restart the systemd service  |
| `gyoza deploy --dry`        | Print the deploy plan without changing anything             |
| `gyoza deploy -y`           | Deploy without confirmation prompts                         |
| `gyoza deploy --force`      | Build and restart even when the pull brought nothing new    |
| `gyoza help`                | Print available commands                                    |

### How it is consumed

Projects add gyoza as a dev dependency and call it from `package.json` scripts:

```json
"devDependencies": {
  "gyoza": "github:timw/gyoza"
},
"scripts": {
  "env:generate": "gyoza env:generate",
  "update:all":   "gyoza update",
  "update:latest":"gyoza update --latest"
}
```

Bun resolves `github:timw/gyoza` and installs from the private GitHub repo.
The `bin` field makes `gyoza` available in `node_modules/.bin`.

---

## Implementation Steps

### Step 1 — `package.json`

```json
{
  "name": "gyoza",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "gyoza": "./cli.ts"
  },
  "dependencies": {
    "type-fest": "^4.x"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

`type-fest` is required by `update.ts` for the `PackageJson` type.

---

### Step 2 — `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext"],
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["bun"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": false,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Note: `noUncheckedIndexedAccess` is intentionally `false`. The parsing code
uses array indexing inside bounds-checked loops and enabling this flag produces
noise without safety value in that pattern.

---

### Step 3 — `cli.ts` (entry point)

The shebang line lets Bun execute the file directly as a bin script.
`cli.ts` tree-walks the `registry` (`CommandGroup`) exported from
`src/commands/index.ts`:

1. Load `gyoza.config.ts` via `loadConfig(process.cwd())`.
2. Inject any `config.custom.init` / `config.custom.generate` scripts into
   the live registry (see **Custom Scripts** below).
3. Recursively walk argv tokens, dispatching to `CommandGroup` children or
   invoking a leaf `Command.run(args)`.
4. `--help` / `help` at any level prints contextual usage.

The `dispatch` function handles the walk; `printGroupHelp` / `printCommandHelp`
format usage output from the registry metadata.

---

### Step 4 — `src/commands/generate.ts`

Port `scripts/generate.ts` from the template verbatim, with these changes:

1. **Wrap in an exported function.** Replace the `main()` IIFE + `main()` call
   at the bottom with:

   ```ts
   export const generateEnv = async (): Promise<void> => {
     // (contents of current main())
   };
   ```

2. **Remove `export default {}`.** Not needed.

3. **Keep all internal logic unchanged**, including:
   - `parseEnvTs` / `parseFrontendEnvTs` — parse `server/env.ts` and
     `frontend/src/env.d.ts` respectively
   - `renderEnv` — renders parsed fields to `.env` format
   - `validateGeneratedEnv` — post-render validation
   - `writeEnvSafe` — backup → write → validate → restore on failure
   - `correctFrontendEnvReadonly` — auto-corrects missing `readonly` in
     `env.d.ts`
   - `parseEnvFile` — reads existing `.env` into a key/value map

#### Critical parsing behavior (do not regress)

The `parseEnvTs` and `parseFrontendEnvTs` functions scan for JSDoc blocks
(`/** ... */`). A **single-line JSDoc** like `/** Database configuration */`
contains both `/**` and `*/` on the same line. The parser must detect this and
NOT enter the multi-line inner loop. The guard is:

```ts
if (trimmed.startsWith('/**')) {
  const blockLines: string[] = [trimmed];

  if (!trimmed.includes('*/')) {   // ← CRITICAL: skip loop for single-line JSDoc
    i++;
    while (i < objectLines.length) {
      blockLines.push(objectLines[i].trim());
      if (objectLines[i].trim().includes('*/')) { break; }
      i++;
    }
  }

  fields.push({ kind: 'section', lines: blockLines });
  ...
}
```

**Without this guard**, the inner loop consumes all lines until the next `*/`,
causing field names to appear inside section headers as raw Zod schema code
(`# DB_HOST: z.string()`) and required fields to disappear from the output
entirely. This was the original critical bug in the template script.

#### Validation

`validateGeneratedEnv` checks two things for each parsed field:

1. The key appears somewhere in the generated output (as `KEY=` or `# KEY=`)
2. No active (uncommented) `KEY=value` line has a value matching
   `/z\.(string|coerce|boolean|number|preprocess|email|url|ipv4)\(/`

`writeEnvSafe` backs up the existing `.env`, writes the new one, runs
validation, and if validation fails: restores the backup and throws. This
prevents overwriting real env values with broken output.

#### EnvField type

```ts
type EnvField =
  | {
      kind: 'field';
      name: string;
      defaultValue?: string;
      optional?: boolean;
      directives: string[];
      comments: string[];
    }
  | { kind: 'section'; lines: string[] }
  | { kind: 'blank' };
```

#### Directive system (server `env.ts`)

Comments immediately above a field are parsed into `directives` (lines
starting with `@`) and `comments` (all other lines). Supported directives:

| Directive                  | Output                                           |
|----------------------------|--------------------------------------------------|
| `@generate base64:N`       | Random base64 string of N characters             |
| `@generate uuid`           | UUID v4 via `randomUUID()` from `node:crypto`    |
| `@generate alphanumeric:N` | Random alphanumeric string of N characters       |
| `@pgurl`                   | `postgresql://user:password@127.0.0.1:5432/dbname` |
| `@mongourl`                | `mongodb://user:password@127.0.0.1:27017/dbname` |
| `@mysqlurl`                | `mysql://user:password@127.0.0.1:3306/dbname`   |
| `@apiurl`                  | `https://api.example.com`                        |
| `@placeholder <value>`     | The literal text after `@placeholder `           |

#### Field rendering rules (server)

| Field has…          | Written as                     |
|---------------------|--------------------------------|
| Existing `.env` value | `KEY=<existing value>` (preserved) |
| `@directive`        | `KEY=<generated/placeholder>`  |
| `.default(value)`   | `# KEY=value` (commented out)  |
| Nothing             | `KEY=` (empty, Zod will error if not filled) |

#### Field rendering rules (frontend `env.d.ts`)

| Field has…              | Written as        |
|-------------------------|-------------------|
| Existing `.env` value   | `KEY=<existing>`  |
| `@directive`            | `KEY=<generated>` |
| `?:` or `string \| undefined` | `# KEY=` (commented out, optional) |
| Nothing                 | `KEY=` (empty)    |

#### Imports for generate.ts

```ts
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
```

---

### Step 5 — `src/commands/update.ts`

Port `scripts/update.ts` from the template with these changes:

1. **Remove the top-level `if (import.meta.main)` block.** Extract its body
   into an exported function:

   ```ts
   export const runUpdate = async (args: string[]): Promise<void> => {
     const latest = args.includes('--latest');
     const yes = args.includes('-y') || args.includes('--yes');
     const catalogMap = await getCatalogPackages();

     const updateCount = await showOutdatedReport(latest);
     if (updateCount === 0) process.exit(0);

     const confirmed = yes || (await confirmUpdate(updateCount));
     if (!confirmed) {
       console.log('Aborted.');
       process.exit(0);
     }

     console.log('');
     await runUpdates(latest);
     await catalogifyWorkspaceDependencies(frontendPackagePath, catalogMap);
     await catalogifyWorkspaceDependencies(serverPackagePath, catalogMap);
     await updateRootCatalog(catalogMap);
     await runInstall();
   };
   ```

2. **Remove `getLatest()` and `getYes()` helpers** — args are now passed in
   from `cli.ts`.

3. **Keep all other logic unchanged:**
   - `getCatalogPackages` — reads root `package.json` catalog
   - `parseOutdatedTable` — parses `bun outdated` ASCII table output
   - `getWorkspaceOutdated` — runs `bun outdated` per workspace
   - `printWorkspaceOutdated` — formats the report to console
   - `showOutdatedReport` — runs all workspaces, prints, returns count
   - `confirmUpdate` — interactive Y/n prompt
   - `runUpdates` — runs `bun update` in each workspace
   - `catalogifyWorkspaceDependencies` — restores `catalog:` references
   - `updateRootCatalog` — writes updated catalog back to root `package.json`
   - `runInstall` — runs `bun install` from root

4. **ESLint: add disable comment for `no-control-regex`** above `stripAnsi`:

   ```ts
   // eslint-disable-next-line no-control-regex
   const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '');
   ```

#### Imports for update.ts

```ts
import { $ } from 'bun';
import { join } from 'node:path';
import type { PackageJson } from 'type-fest';
```

---

### Step 6 — ESLint config

Create a root `eslint.config.mjs`. Base it on the template's root ESLint
config. Key rules:

- `@typescript-eslint/no-unused-vars`: warn, ignore `^_` pattern
- `@typescript-eslint/ban-ts-comment`: off
- `prefer-const`: error
- `no-useless-assignment`: error

Exclude `node_modules/`.

---

### Step 7 — Prettier config

Copy `.prettierrc.mjs` from the template root as-is. The formatting
conventions should match so that contributors working across both repos
don't fight whitespace diffs.

---

## Updating the Template

Once gyoza is published on GitHub, update `hono-react-template`:

1. Add to root `package.json` devDependencies:
   ```json
   "gyoza": "github:timw/gyoza"
   ```

2. Replace `package.json` scripts:
   ```json
   "env:generate": "gyoza env:generate",
   "update:all":   "gyoza update",
   "update:latest":"gyoza update --latest"
   ```

3. Delete `scripts/generate.ts` and `scripts/update.ts` from the template.
   `scripts/build.ts` and `scripts/migrate.ts` remain in the template for now
   as they have project-specific assumptions (Drizzle migration checking, etc.)
   and are candidates for future gyoza commands.

4. Update `CLAUDE.md` in the template to remove documentation for the deleted
   scripts and note that `env:generate` and `update` are provided by gyoza.

---

## Verification Checklist

Before considering the initial implementation complete:

- [ ] `gyoza help` prints the command list
- [ ] `gyoza env:generate` run from a `hono-react-template` project root
      generates correct `server/.env` and `frontend/.env`
- [ ] `gyoza env:generate` creates `.env.backup` files when `.env` files exist
- [ ] `gyoza env:generate` fails with a clear error and restores backup when
      validation detects Zod code leaked into a value
- [ ] `gyoza update` shows the outdated report and prompts for confirmation
- [ ] `gyoza update -y` skips the prompt
- [ ] `gyoza update --latest` uses latest versions
- [ ] `gyoza update` moves a `catalog` entry to the newest in-range release;
      `gyoza update --latest` moves it to the absolute latest, both shown in a
      "Catalog (package.json)" report section that counts toward the prompt
- [ ] an exact-pinned `catalog` entry is left alone unless `--force`; a
      `minimumReleaseAge` gate still applies to the catalog pick
- [ ] a package `bun outdated` marks with `*` (age-gated) whose installable
      version already matches what is installed does not appear in the report;
      catalogued packages never appear in the per-workspace tables
- [ ] a pinned package with a newer version is shown in the report tagged
      `(pinned, not updated)` and is excluded from the "N updates" count; when
      every outstanding update is pinned, `gyoza update` says so and exits
- [ ] `gyoza init eslint --dry` writes `eslint-migration.md` with four sections; sections with no `.mts` file say "not found"
- [ ] `gyoza init eslint` renames `.mts` → `.mjs`, strips `@ts-*` directives, injects JSDoc before `defineConfig(`
- [ ] `gyoza init eslint` skips a directory when `.mjs` already exists and prints a warning
- [ ] `gyoza init eslint` prompts to remove `eslint-migration.md` if it exists after migration
- [ ] `gyoza init scripts --dry` prints a console preview of all script changes and file deletions without touching files
- [ ] `gyoza init scripts` upserts the four target scripts, removes legacy 'env' aliases, deletes `scripts/build.ts` / `prepare.ts` / `update.ts` if present
- [ ] `gyoza init scripts` skips a target script that already calls `gyoza` (customised)
- [ ] `gyoza init scripts` deletes `./scripts/` folder when it becomes empty
- [ ] `gyoza add date-fns` (no `--catalog`) behaves identically to `bun add date-fns`
- [ ] `gyoza add --catalog server,frontend date-fns` appends `^<latest>` to the root
      catalog and writes `"date-fns": "catalog:"` into both workspaces only
- [ ] `gyoza add --catalog shared date-fns` on an already-catalogued package extends
      it to `shared` without resolving or bumping the catalog version
- [ ] `gyoza add --catalog shared date-fns@^3.0.4` on an already-catalogued package
      prompts with the affected workspaces and defaults to no
- [ ] `gyoza add --catalog frontend react@next` pins the prerelease exactly, no caret
- [ ] `gyoza add --catalog server date-fns@bogustag` errors instead of silently
      cataloguing `latest`
- [ ] With `minimumReleaseAge` set in `bunfig.toml`, `gyoza add --catalog server,frontend
      better-auth` catalogs the newest release older than the gate, notes the
      substitution, and the follow-up `bun install` succeeds
- [ ] `gyoza add --catalog nope date-fns` errors listing the valid workspace names
- [ ] `gyoza add --catalog server --only-missing date-fns` errors on the unsupported flag
- [ ] `gyoza remove --catalog <all workspaces> date-fns` prompts to prune the orphaned
      catalog entry; removing from a subset leaves the entry alone
- [ ] `--dry` on either command prints the plan and modifies nothing
- [ ] `gyoza upgrade` from a project with a stale gyoza reports `old -> new` and
      prints the changelog entries between them
- [ ] `gyoza upgrade` when already current prints "Already up to date"
- [ ] `gyoza upgrade` with a `#tag` spec warns about the ref and reports a
      downgrade as a downgrade, with no changelog section
- [ ] `gyoza upgrade` from a project that doesn't declare gyoza exits 1 with a
      clear message
- [ ] `gyoza upgrade` from a source checkout exits 1 naming the directory
- [ ] A `post` step reads `results.pre.<key>` with the exact type the `pre` step
      returned, with no annotation anywhere in the config
- [ ] A step returning nothing leaves no key in `results`; `0` / `false` / `''` do
- [ ] `gyoza build` warns once (not three times) on an array-form config, and the
      steps still run in declaration order
- [ ] An object key that is a plain number aborts the build with exit 1 **before**
      the build directory is cleaned
- [ ] `build.pre` as an object with `build.post` as an array is a preflight error
- [ ] `gyoza deploy --dry` prints the plan (branch, pull cmd, incoming commits,
      install/migrate/build/restart) and mutates nothing
- [ ] `gyoza deploy` on an up-to-date branch prints "Already up to date" and exits
      0; `--force` still builds and restarts
- [ ] a diverged server tree makes `git pull --ff-only` abort with a clear message
      and no further steps run
- [ ] `bun install` runs only when `bun.lock` is in the pulled diff
- [ ] `deploy.migrate` as a script name runs `bun run <name>`; a missing script
      aborts with exit 1
- [ ] `deploy.migrate` as a callback receives `{ projectRoot, changedFiles,
      fromRef, toRef }`
- [ ] `deploy.migrate` unset + changed `.sql` files prompts `[y/N]`; declining
      exits 1
- [ ] `deploy.service` unset prompts to finish without a restart; unset + no TTY +
      no `--yes` exits 1 naming the field
- [ ] `deploy.service` as `'app'` and `['app','worker.service']` both produce one
      `sudo systemctl restart` call with `.service` suffixes normalized
- [ ] a failing `gyoza build` aborts the deploy before the service is restarted
- [ ] a malformed `deploy` config (numeric `service`, empty `migrate`) aborts with
      exit 1 before anything is pulled
- [ ] an unknown flag to `gyoza deploy` exits 1 listing the supported flags
- [ ] Unknown commands print an error and exit 1
- [ ] `bunx tsc --noEmit` passes with zero errors
- [ ] `bun run lint` passes with zero errors and zero warnings
- [ ] `bun test` passes

---

## Custom Scripts

Projects can register project-specific subcommands under `gyoza init` and
`gyoza generate` via the `custom` field in `gyoza.config.ts`:

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  custom: {
    init: {
      printHello: () => console.log('Hello!'),
    },
    generate: {
      scaffold: async () => {
        // any async logic
      },
    },
  },
} satisfies GyozaConfig;
```

Running `gyoza init printHello` or `gyoza generate scaffold` invokes the
corresponding function.

### Collision rules

- Built-in commands always win. If a custom script shares a name with a
  built-in, gyoza prints a warning at startup and ignores the custom entry.
- The collision check is runtime-only. TypeScript's index signature rules make
  a compile-time guard unworkable here: an intersection of `{ [K: string]: Fn }`
  and `{ knownKey?: never }` causes TypeScript to apply `never` to *all* keys,
  not just the reserved one.

### How `KnownInitCommand` / `KnownGenerateCommand` stay in sync

These types are derived directly from the registry objects:

```ts
// src/commands/init/index.ts
export const initGroup = gyoza('Project initialization commands', (cmd) => ({
  config:  cmd(...),
  eslint:  cmd(...),
  scripts: cmd(...),
}));
export type KnownInitCommand = keyof typeof initGroup.commands; // 'config' | 'eslint' | 'scripts'
```

No manual list to maintain — adding a new built-in command to `initGroup` or
`generateGroup` automatically updates the type. The types are exported for
documentation and tooling purposes.

---

## `gyoza init scripts` — Package.json Script Upsert

Upserts canonical gyoza scripts in the project root `package.json` and removes
legacy per-project script files left over from `hono-react-template`.

### Target scripts

| Key              | Command                 |
|------------------|-------------------------|
| `build`          | `gyoza build`           |
| `update:all`     | `gyoza update`          |
| `update:latest`  | `gyoza update --latest` |
| `generate:env`   | `gyoza generate env`    |

### Skip / replace / add logic (per target script)

- If the existing script value contains `gyoza` anywhere → **skip** (assume customised).
- If the script key exists but the value doesn't call `gyoza` → **replace**.
- If the script key is absent → **add**.

### Legacy 'env' script removal

Any script key that:
1. Contains `'env'` (case-insensitive), AND
2. Is not one of the target keys above

...is **removed**, regardless of its value. This standardizes all env-related
scripts to the canonical `generate:env` key — even `"env:generate": "gyoza generate env"`
is replaced, since the old key name is the issue, not the value.

### `./scripts/` folder cleanup

If `./scripts/` exists, `build.ts`, `prepare.ts`, and `update.ts` are deleted
individually if present. After deletion, if the folder is empty it is also
removed. Other files in the folder are left untouched.

### `--dry` mode

Prints a two-section console report without touching any files:

```
Scripts (package.json):
  "build": "bun run scripts/build.ts" -> "build": "gyoza build"
  "env:generate": "bun run scripts/generate.ts" -> REMOVED
  "generate:env": (none) -> "generate:env": "gyoza generate env"

Script files:
  scripts/build.ts -> DELETED
  scripts/ -> DELETED (empty after removals)
```

If nothing would change, prints `  No changes needed.`

---

## `gyoza init eslint` — ESLint Config Migration

Migrates `eslint.config.mts` files to `eslint.config.mjs` in these locations
(searched in order): `./`, `frontend/`, `server/`, `shared/`.

### Flags

| Flag    | Effect                                                       |
|---------|--------------------------------------------------------------|
| `--dry` | Write `eslint-migration.md` preview; do not touch any files  |

### `--dry` mode output

Writes `eslint-migration.md` to `process.cwd()` with four `##` sections (one
per search directory). Each section contains either:
- `` `eslint.config.mts` not found `` — if no `.mts` exists in that directory
- A fenced ` ```js ` block with the fully-transformed output — if `.mts` exists

If `.mts` exists but `.mjs` also exists, a blockquote note is inserted above
the code block: `> Note: eslint.config.mjs already exists — would be skipped`.

### Normal mode behaviour

Per directory:
1. Skip silently if no `.mts` exists.
2. Skip with a `⚠` warning if `.mjs` already exists.
3. Otherwise: transform the `.mts` content, write `.mjs`, delete `.mts`.

After all directories are processed, if `eslint-migration.md` exists in the
project root, the user is prompted `[Y/n]` to remove it (default yes).

### Transformation rules (`src/commands/init/eslint.ts → transform()`)

Applied in order to every migrated file:

1. **Remove standalone `@ts-*` directive lines** — any line matching
   `/^\s*\/\/ @ts-\S+/` is dropped entirely (handles `@ts-check`,
   `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`).

2. **Strip inline `@ts-*` trailing comments** — removes ` // @ts-\S+.*`
   from the end of lines that also contain code.

3. **Inject JSDoc before `defineConfig(`** — when a line contains
   `defineConfig(`, inserts `/** @type {import('eslint').Linter.Config[]} */`
   on the line immediately before it, unless that comment is already the
   previous non-blank line.

4. **Collapse consecutive blank lines** — runs of 2+ blank lines are reduced
   to one (cleaning up gaps left by removed directive lines).

---

## `gyoza add` / `gyoza remove` — Catalog-Aware Bun Wrappers

Bun has no CLI affordance for writing to a workspace catalog — `bun add` has no
`--catalog` flag (see `ADD_PARAMS` in bun's `CommandLineArguments.rs`) and there
is no `bun catalog` command. These wrappers fill that gap.

Full user-facing documentation lives in [docs/catalog.md](docs/catalog.md). The
implementation notes below are the ones worth not regressing.

### Mode switch

The presence of `--catalog` (or `--catalog=…`) is the only thing that separates
the two modes. Without it, argv is handed to `bun add` / `bun remove` untouched
via `Bun.spawn` with inherited stdio, and gyoza exits with bun's code. Catalog
mode never invokes `bun add` at all — it writes `package.json` directly and then
runs a single `bun install`.

That is why `-a`/`--analyze` and `--only-missing` are **rejected with an error**
in catalog mode: there is no `bun add` invocation to pass them to, and silently
dropping them would be worse than failing.

### Version resolution (`src/version.ts`)

`bun info` is the resolver. Two behaviors to guard against:

1. **`bun info pkg@bogustag version` silently returns `latest`** — it does not
   error. `resolveCatalogVersion` therefore validates any dist-tag against
   `bun info pkg dist-tags` *before* trusting the resolved version.
2. **A missing package prints a 404 to stderr but the exit code is not a reliable
   signal** — empty stdout is what `bunInfo` checks.

`isVersionOrRange` decides verbatim-vs-resolve. It must **not** do a bare `x`
substring test: `next` contains an `x`. Wildcards are handled by the leading-digit
rule (`3.x`) plus exact matches on `*` and `x`.

### minimumReleaseAge (`src/bunfig.ts`, `selectByReleaseAge`)

`bun info` reports the absolute latest version, but `bun install` refuses anything
published inside `[install] minimumReleaseAge`. Cataloguing the `bun info` answer
therefore produces a `package.json` bun itself rejects:

```
error: No version matching "better-auth" found for specifier "^1.6.26"
       (blocked by minimum-release-age: 432000 seconds)
```

So the version must be **chosen** here, not discovered at install time.
`selectByReleaseAge` takes the resolved latest as an upper bound and picks the
newest version at or below it whose `bun info <pkg> time` entry predates the
cutoff. Rules that matter:

- **Stability is matched to the bound.** A stable target never silently drops to a
  prerelease, and a `@next` target stays within prereleases.
- **`created` / `modified` are not versions** — they must be stripped from the
  `time` map or `modified` sorts as the newest "version".
- `minimumReleaseAgeExcludes` and an unset/zero age both short-circuit before any
  registry call.
- Nothing eligible is an error naming the excludes escape hatch, never a silent
  fallback to the blocked version.

Bun parses `.toml` natively, so `await import(path)` is the entire bunfig parser.
The project `bunfig.toml` overrides `~/.bunfig.toml` key by key.

`compareVersions` lives in `src/version.ts` and implements real semver prerelease
ordering (numeric identifiers below alphanumeric, `rc.4` below `rc.10`). Selecting
versions needs that precision — a naive core-only compare picks the wrong prerelease.

Prereleases are pinned exactly, never caret-ranged — `^5.0.0-alpha.0` would match
a stable `5.0.0`. This also makes them pinned as far as `gyoza update` is
concerned, since `isPinnedVersion` in `update.ts` matches `5.0.0-alpha.0`.

### Catalog ordering

New entries are **appended**. Never re-sort the existing `catalog` object — a sort
would turn the first run in any real project into one enormous diff.

### The extend case

`gyoza add --catalog shared date-fns` where `date-fns` is already catalogued and
no version was given must reuse the existing catalog value, skip resolution
entirely, and leave every other workspace untouched. This is the most common
invocation and the one that must never bump a shared version.

Only an explicit differing version can change a catalog entry, and it prompts
first (defaulting to **no**) listing every workspace that references it.

### Section handling

`applyChanges` deletes the package from all four dependency sections before
writing the `catalog:` reference, so `-d` on a package already in `dependencies`
moves it rather than duplicating it. Emptied sections are removed, as is an
emptied `catalog` object.

### Scope

Named catalogs (`catalogs: { testing: {...} }`, `catalog:testing`) are **not
supported** — the framework these commands serve uses a single top-level
`catalog`. `gyoza install` is not wrapped.

---

## Build Step Results (`defineConfig`)

`build.pre` / `build.post` take a keyed object; each step's return value lands in
`ctx.results` under its key. User-facing docs in [docs/config.md](docs/config.md).
The constraints worth not re-litigating:

### Cross-phase typing works, same-phase typing does not

A `post` step sees `results.pre.<key>` fully typed. A step reading its **own**
phase's results gets `unknown`. This is forced, not an oversight.

Typing a phase's own results means the type inferred *from* that phase's step map
(`TPre`) is also referenced *inside* that same map's parameter positions. TypeScript
resolves the cycle by collapsing **the reading step's own return type** to `unknown`
— and that error then surfaces in whichever *later* step consumes the value, nowhere
near the cause. Measured, not assumed: with `Partial<TPre>` in the pre context, only
the steps that actually read `results` degraded; steps ignoring `ctx` inferred fine,
which is exactly what makes the failure so confusing.

An explicit return-type annotation on the reading step does fix it, so a "just
annotate" variant is possible. It was rejected: the penalty for forgetting is an
error in a different step. `TPost` was dropped entirely for the same reason — with
same-phase typing gone it had no remaining use.

Do not "fix" this by reintroducing `Partial<TPre>` into `PreStepContext` without
re-running `tests/build-steps.types.ts`, which asserts the current shape.

### Why an object, not an array of `{ key, … }`

TypeScript rejects duplicate keys in an object literal, so uniqueness is a
compile-time guarantee rather than a runtime check. Keys also stay literal without
a `const` type parameter. The array form survives as deprecated and contributes
nothing to `results` — it has no key to file a result under.

### Preflight runs before everything

`validateBuildConfig` is called before typecheck/lint/clean, so a malformed config
never leaves a half-built `build/`. Integer-like keys (`"0"`, `"12"`) are a hard
error: JS property ordering hoists canonical array indices ahead of string keys and
sorts them numerically, so such a step would not run where it is written. Every
other string key is insertion-ordered per spec.

### The `defineConfig` brand

`Symbol.for('gyoza.config')`, non-enumerable, so it survives a duplicated install
and stays out of spreads and `JSON.stringify`. `mergeConfig` builds a fresh object,
so `loadConfig` must re-brand from the **raw** imported default — checking the merged
result would always be false.

---

## `gyoza upgrade` — Self-Update

Updates gyoza itself and nothing else. Full documentation in
[docs/upgrade.md](docs/upgrade.md).

### Why it is needed

Gyoza is installed from git with no version range, which makes it invisible to
the normal update path in two separate ways (both verified against bun 1.3.14):

1. **`bun install` will not move a git dep** whose spec is unchanged — the
   lockfile pins a commit and there is no range to re-satisfy, so a stale entry
   stays stale forever.
2. **`bun outdated` returns nothing at all for git deps**, so gyoza can never
   appear in `gyoza update`'s report regardless of how far behind it is.

`bun update gyoza` *does* re-resolve to the remote's current commit. That is the
primitive this command wraps.

### Implementation notes

- **This is the one command that resolves against its own install location**
  (`import.meta.dir`) rather than `process.cwd()`. It is updating itself, not the
  project. Everything else must keep following the `process.cwd()` rule.
- The before/after versions are read from the gyoza package directory on either
  side of the `bun update` call. **Do not parse `bun.lock`** — it is JSONC with no
  public parser, and reading `package.json` twice gives the same answer reliably.
- `bun update` runs from whichever directory declares gyoza (root first, then
  workspaces), because that is the package.json bun will rewrite.

### Refs are reported, not blocked

A spec may carry a ref: `#main` (a branch — tracks and moves), `#v0.5.0` or
`#61cd181` (a tag or commit — does not). **These are indistinguishable without
querying the remote**, so an earlier draft that errored on any `#` was wrong — it
would have rejected a perfectly valid branch spec. The command notes the ref, runs
the update, and reports what actually happened.

### Direction matters

A pinned ref older than what is installed produces a legitimate downgrade.
`compareVersions` detects the direction; the changelog section is printed **only
when moving forward**, since an older release's changelog cannot describe what
changed since a newer one.

### Changelog output

`changelogSince` walks the newly installed `changelog.md` from the top (entries
are newest-first) collecting sections until it reaches the previously installed
version. `package.json` has no `files` field, so the whole repo — changelog
included — ships with the package.

---

## `gyoza deploy` — Server Deployment

Orchestrates a full deployment on the server. Full documentation in
[docs/deploy.md](docs/deploy.md). Config lives under `deploy` in `gyoza.config.ts`
([docs/config.md](docs/config.md#deploy-config)).

Sequence: preflight → `git pull --ff-only origin <branch>` → `bun install` (only if
`bun.lock` moved in the pulled diff) → `deploy.migrate` → `runBuild([])` in-process
→ `sudo systemctl restart <units>`.

### Firsts

This is the **first command that runs on the server** and the **first that shells
out to `git`** — nothing else in gyoza does either. It still follows the
`process.cwd()` rule (unlike `gyoza upgrade`). git/bun/systemctl are invoked with
`Bun.spawn`, mirroring `update.ts`/`upgrade.ts`; there is no git library.

### Why `--ff-only`

Plain `git pull` creates a merge commit whenever the server checkout has a commit
the remote lacks (in-place hotfix, half-finished prior deploy, CRLF churn).
`--ff-only` turns that into a loud failure instead of a silent merge. A dirty
working tree aborts in preflight for the same reason — no `--force` override in v1.

### Migrate runs every deploy

When `deploy.migrate` is set it runs on every deploy; the migration tool is
trusted to no-op when nothing is pending. The `.sql`-in-diff scan is **only** used
to decide whether to warn when `deploy.migrate` is *absent* — it is not a gate on
running migrations. `deploy.migrate` as a string is verified against
`package.json` `scripts` before running (`bun run <name>`); as a function it gets
`{ projectRoot, changedFiles, fromRef, toRef }`.

### Service restart

`sudo systemctl restart` — units are system units. `string | string[]`; an array
is one `systemctl` call. `normalizeServices` appends `.service` when the name has
no dot. The deploy user needs a NOPASSWD sudoers entry for the restart.

### Non-interactive aborts, never skips

`deploy.service` or `deploy.migrate` (with `.sql` changes) missing + no TTY + no
`--yes` → exit 1 naming the field. `confirm()` in `src/prompt.ts` has no TTY guard
and returns `false` on closed stdin, so `deploy.ts` checks `process.stdin.isTTY`
explicitly before each prompt to give a clear message rather than a bare abort.
`confirm()` itself is unchanged — other commands depend on its current behaviour.

### Failure leaves the old service running

A failed `runBuild` `process.exit(1)`s before the restart step, so the previous
build keeps serving. The pull is **not** reverted; re-running `gyoza deploy` after
fixing the cause is a no-op on the pull and proceeds from there.

---

## Notes

- All path resolution uses `process.cwd()`, so gyoza always operates on the
  project it is run from, not its own install location.
- The package is `"private": true`. If it ever goes public, scope it as
  `@timw/gyoza` to avoid npm squatting on the unscoped name.
- The template's `migrate.ts` is not ported wholesale — `gyoza deploy` instead
  delegates migrations to a project-supplied `deploy.migrate` script or callback.
