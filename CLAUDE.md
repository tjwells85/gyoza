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
    ├── config.ts           ← GyozaConfig, CustomScripts, loadConfig
    ├── gyoza.ts            ← Command/CommandGroup types, registry builder
    └── commands/
        ├── index.ts        ← registry root (assembles all groups)
        ├── build.ts        ← gyoza build
        ├── update.ts       ← gyoza update
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
| `gyoza update`              | Interactive dependency updater                              |
| `gyoza update --latest`     | Update to latest versions (ignores semver range)            |
| `gyoza update -y`           | Skip confirmation prompt                                    |
| `gyoza build`               | Build the project                                           |
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
- [ ] `gyoza init eslint --dry` writes `eslint-migration.md` with four sections; sections with no `.mts` file say "not found"
- [ ] `gyoza init eslint` renames `.mts` → `.mjs`, strips `@ts-*` directives, injects JSDoc before `defineConfig(`
- [ ] `gyoza init eslint` skips a directory when `.mjs` already exists and prints a warning
- [ ] `gyoza init eslint` prompts to remove `eslint-migration.md` if it exists after migration
- [ ] `gyoza init scripts --dry` prints a console preview of all script changes and file deletions without touching files
- [ ] `gyoza init scripts` upserts the four target scripts, removes legacy 'env' aliases, deletes `scripts/build.ts` / `prepare.ts` / `update.ts` if present
- [ ] `gyoza init scripts` skips a target script that already calls `gyoza` (customised)
- [ ] `gyoza init scripts` deletes `./scripts/` folder when it becomes empty
- [ ] Unknown commands print an error and exit 1
- [ ] `bunx tsc --noEmit` passes with zero errors
- [ ] `bun run lint` passes with zero errors and zero warnings

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
2. Is not one of the target keys above, AND
3. Its value does not call `gyoza`

...is **removed**. This cleans up old aliases like `env:generate` or `prepare:env`.

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

## Notes

- All path resolution uses `process.cwd()`, so gyoza always operates on the
  project it is run from, not its own install location.
- The package is `"private": true`. If it ever goes public, scope it as
  `@timw/gyoza` to avoid npm squatting on the unscoped name.
- `build.ts` and `migrate.ts` from the template are **not** in scope for this
  initial implementation.
