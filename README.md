# gyoza

CLI tooling for projects scaffolded from [`hono-react-template`](https://github.com/tjwells85/hono-react-template) — a fullstack Bun + Hono + React monorepo. Gyoza extracts the maintenance scripts into a versioned package so all downstream projects receive bug fixes and improvements via `bun update`.

> The name: Hono means "flame", Bun's mascot is a bao, gyoza are pan-fried dumplings — fire + bao.

---

## Installation

Add gyoza as a dev dependency in your project root `package.json`:

```json
"devDependencies": {
  "gyoza": "github:tjwells85/gyoza"
}
```

Run `bun install`, then wire up your scripts:

```json
"scripts": {
  "generate:env":   "gyoza generate env",
  "update:all":     "gyoza update",
  "update:latest":  "gyoza update --latest"
}
```

---

## Commands

### `generate env`

Generates `server/.env` and `frontend/.env` from their respective schema files. Existing values are preserved. A `.env.backup` is written before any existing file is overwritten, and the file is restored if validation fails.

```bash
gyoza generate env
```

**Sources:**

| File                    | Parsed as                            |
| ----------------------- | ------------------------------------ |
| `server/env.ts`         | Zod `z.object({...})` schema         |
| `frontend/src/env.d.ts` | TypeScript `interface ImportMetaEnv` |

**Directives** — add as `//` comments immediately above a field in `server/env.ts`:

| Directive                  | Generated value                                      |
| -------------------------- | ---------------------------------------------------- |
| `@generate base64:N`       | Random base64 string of N characters                 |
| `@generate uuid`           | UUID v4                                              |
| `@generate alphanumeric:N` | Random alphanumeric string of N characters           |
| `@pgurl`                   | `postgresql://user:password@127.0.0.1:5432/dbname`   |
| `@mongourl`                | `mongodb://user:password@127.0.0.1:27017/dbname`     |
| `@mysqlurl`                | `mysql://user:password@127.0.0.1:3306/dbname`        |
| `@apiurl`                  | `https://api.example.com`                            |
| `@placeholder <value>`     | The literal text after `@placeholder`                |

**Rendering rules (server `env.ts`):**

| Field has…            | Written as                                               |
| --------------------- | -------------------------------------------------------- |
| Existing `.env` value | `KEY=<existing>` (preserved)                             |
| `@directive`          | `KEY=<generated>`                                        |
| `.default(value)`     | `# KEY=value` (commented out)                            |
| Nothing               | `KEY=` (empty — Zod will error at runtime if not filled) |

**Rendering rules (frontend `env.d.ts`):**

| Field has…                    | Written as               |
| ----------------------------- | ------------------------ |
| Existing `.env` value         | `KEY=<existing>`         |
| `@directive`                  | `KEY=<generated>`        |
| `?:` or `string \| undefined` | `# KEY=` (commented out) |
| Nothing                       | `KEY=` (empty)           |

---

### `update`

Checks all workspaces (root, frontend, server, shared) for outdated dependencies, shows a report, and runs `bun update`. After updating, restores `catalog:` references in workspace `package.json` files and writes updated versions back to the root catalog.

```bash
gyoza update              # interactive, respects semver range
gyoza update --latest     # update to latest (ignores semver range)
gyoza update -y           # skip confirmation prompt
```

---

### `build`

Builds the monorepo for production. Runs in phases:

1. **Clean install** — (optional) removes all `node_modules` recursively then runs `bun install`
2. **Clean** — removes and recreates the `build/` directory
3. **Pre steps** — any `gyoza.config.ts` steps in `build.pre`
4. **Build** — compiles the frontend (`bun run --filter=frontend build`) and bundles the server (`Bun.build`)
5. **Assemble** — copies `frontend/dist` → `build/client` and `server/.env` → `build/.env`
6. **Post steps** — any `gyoza.config.ts` steps in `build.post`

```bash
gyoza build
```

#### Extending the build with `gyoza.config.ts`

Create `gyoza.config.ts` in your project root to configure the build. Use `build.pre` for steps that run before the frontend/server build; `build.post` for steps that run after assembly.

```ts
// gyoza.config.ts
import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,   // set true to wipe all node_modules and re-install before building
    typecheck: 'fail',     // 'off' | 'warn' | 'fail' — runs tsc --noEmit before the build
    lint: 'fail',          // 'off' | 'warn' | 'fail' | { onError, onWarning } — runs eslint . before the build
    pre: [],
    post: [
      {
        name: 'Copy Rust CLI',
        run: async ({ buildDir }) => {
          await Bun.write(`${buildDir}/mycli`, Bun.file('target/release/mycli'));
        },
      },
    ],
  },
} satisfies GyozaConfig;
```

`typecheck` and `lint` both default to `'off'`. `'warn'` prints a summary of errors/warnings and continues; `'fail'` aborts the build if any issues are found. `lint` additionally accepts an object for independent control:

```ts
lint: { onError: 'fail', onWarning: 'warn' }  // fail on errors, warn on warnings
```

Both checks run in parallel before the build directory is cleaned, so a failed check leaves the existing build intact.

If no `gyoza.config.ts` exists the build proceeds normally with no extra steps.

---

### `init eslint`

Migrates `eslint.config.mts` files to `eslint.config.mjs` across all workspaces (`./`, `frontend/`, `server/`, `shared/`). Each file is transformed in place: TypeScript-only `// @ts-*` directives are removed, and a `/** @type {import('eslint').Linter.Config[]} */` JSDoc is inserted before any `defineConfig(` call so type information is preserved in plain JS. Directories that already have an `.mjs` file are skipped.

```bash
gyoza init eslint          # migrate all workspaces
gyoza init eslint --dry    # preview — writes eslint-migration.md, touches nothing
```

**`--dry` mode** writes `eslint-migration.md` to the project root. The file has four sections — one per workspace. Each section shows either `eslint.config.mts not found` or a `js` code block containing the fully-transformed output. Run this first to review all four files before committing.

After a normal migration, if `eslint-migration.md` exists from a previous dry run, gyoza prompts to remove it.

---

### `init config`

Scaffolds a `gyoza.config.ts` in the project root. If a legacy config (using `export const buildSteps`) is detected, migrates it to the current format instead of failing.

```bash
gyoza init config
```

The generated file:

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,
    pre: [],
    post: [
      {
        name: 'Example post-build step',
        run: async ({ projectRoot, buildDir }) => {
          console.log(`Build finished. Root: ${projectRoot}, Output: ${buildDir}`);
        },
      },
    ],
  },
} satisfies GyozaConfig;
```

**Migration:** if a legacy `buildSteps` config is found, `gyoza init config` rewrites it into `build.steps` (a deprecated compatibility field) so nothing breaks. Move entries into `build.pre` / `build.post` (without the `phase` field) when convenient.

---

### Custom scripts

Projects can define their own subcommands under `gyoza init` and `gyoza generate` via the `custom` field in `gyoza.config.ts`:

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

`gyoza init printHello` and `gyoza generate scaffold` then invoke the corresponding function.

**Collision rules:**

- Built-in commands always win. If a custom script name matches a built-in, gyoza prints a warning at startup and ignores the custom entry.
- The collision check is runtime-only. TypeScript's index signature intersection rules make a compile-time guard for this pattern unworkable.
- `KnownInitCommand` and `KnownGenerateCommand` are exported types derived directly from the registry objects — they stay in sync automatically and are available for documentation or tooling use.

---

### `help`

```bash
gyoza help
gyoza --help
gyoza <namespace> --help    # e.g. gyoza generate --help
gyoza <command> --help      # e.g. gyoza update --help
gyoza <namespace> <command> --help   # e.g. gyoza generate env --help
```

Prints help at any level of the command tree. Updated automatically as new commands are added.

---

## Public API

Gyoza exports types and the factory function from its root entry point:

```ts
import type { BuildConfig, BuildContext, BuildStep, GyozaConfig, Command, CommandFlag, CommandGroup, GyozaNode } from 'gyoza';
```

| Export           | Description                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `GyozaConfig`    | Top-level config shape for `gyoza.config.ts`                                                 |
| `BuildConfig`    | `build` section of `GyozaConfig`: `cleanInstall`, `typecheck`, `lint`, `pre`, `post`         |
| `TypeCheckLevel` | `'off' \| 'warn' \| 'fail'` - controls `tsc --noEmit` pre-build check                        |
| `LintCheckLevel` | `'off' \| 'warn' \| 'fail' \| { onError, onWarning }` - controls `eslint .` pre-build check  |
| `CheckAction`    | `'warn' \| 'fail'` - action taken when a check finds issues                                  |
| `BuildStep`      | A custom step: `name` and `run(ctx)`; `phase` is deprecated                                  |
| `BuildContext`   | Passed to each `BuildStep.run`: `projectRoot`, `buildDir`                                    |
| `CustomScripts`  | `custom` section of `GyozaConfig`: `init` and `generate` maps of custom script functions     |
| `Command`        | Leaf node: `description`, `flags?`, and `run`                                                |
| `CommandGroup`   | Branch node: `description` and `commands` record                                             |
| `GyozaNode`      | Union of `Command \| CommandGroup`                                                           |
| `CommandFlag`    | A flag descriptor: `{ flag: string, description: string }`                                   |

---

## Developing New Commands

Gyoza uses a command registry. Each command is a file in `src/commands/` that exports a `Command` object. Adding a new command takes three steps — no changes to `cli.ts` required.

Every command tree is built with the `gyoza` factory. It injects a `cmd` helper into a callback — you never import `cmd` separately.

```ts
import { gyoza } from '../../gyoza.ts';

export const myGroup = gyoza('Group description', (cmd) => ({
  subcommand: cmd('Subcommand description', runFn, optionalFlags),
  nested:     gyoza('Nested group', (cmd) => ({
    deeper: cmd('Nested subcommand', runDeep),
  })),
}));
```

### Standalone command

For top-level commands with no subcommands (like `update`, `build`), export `description`, `run`, and optionally `flags` from the command file:

```ts
// src/commands/lint.ts
export const description = 'Lint the monorepo';

export const run = async (_args: string[]): Promise<void> => {
  // implementation
};
```

Then register it in [src/commands/index.ts](src/commands/index.ts):

```ts
import * as lint from './lint.ts'; // ← add import

export const registry = gyoza('gyoza — ...', (cmd) => ({
  // existing entries...
  lint: cmd(lint.description, lint.run), // ← add here
}));
```

### Namespace command

For commands that live under a namespace (`generate types`, `drizzle init`, etc.), add a file inside the namespace directory and register it in that namespace's `index.ts`.

**Step 1** — Create the command file:

```ts
// src/commands/generate/types.ts
export const description = 'Generate TypeScript types from the database schema';

export const run = async (_args: string[]): Promise<void> => {
  // implementation
};
```

**Step 2** — Register in the namespace index:

```ts
// src/commands/generate/index.ts
import { gyoza } from '../../gyoza.ts';
import * as env from './env.ts';
import * as types from './types.ts'; // ← add import

export const generateGroup = gyoza('Code generation commands', (cmd) => ({
  env:   cmd(env.description, env.run),
  types: cmd(types.description, types.run), // ← add here
}));
```

Nothing else changes. `gyoza generate --help` automatically shows the new command.

### Adding a new namespace

Create the directory, an `index.ts` that calls `gyoza()`, and register the group in the root [src/commands/index.ts](src/commands/index.ts):

```text
src/commands/drizzle/
├── index.ts   ← calls gyoza(), exports drizzleGroup
├── init.ts    ← exports description + run
└── migrate.ts ← exports description + run
```

```ts
// src/commands/drizzle/index.ts
import { gyoza } from '../../gyoza.ts';
import * as init from './init.ts';
import * as migrate from './migrate.ts';

export const drizzleGroup = gyoza('Drizzle ORM commands', (cmd) => ({
  init:    cmd(init.description, init.run),
  migrate: cmd(migrate.description, migrate.run),
}));
```

```ts
// src/commands/index.ts — add one import and one line
import { drizzleGroup } from './drizzle/index.ts';

export const registry = gyoza('gyoza — ...', (cmd) => ({
  generate: generateGroup,
  init:     initGroup,
  drizzle:  drizzleGroup, // ← add here
  update:   cmd(...),
  build:    cmd(...),
}));
```

`gyoza drizzle --help` immediately works. No other changes required.

### The `gyoza` factory

```ts
// src/gyoza.ts
export const gyoza = (
  description: string,
  builder: (cmd: CommandFactory) => Record<string, GyozaNode>,
): CommandGroup => { ... };
```

The injected `cmd` helper creates a leaf `Command`:

```ts
cmd(description: string, run: Handler, flags?: CommandFlag[]): Command
```

`flags` is optional — omit it for commands with no options.

### Naming conventions

| Pattern | Examples |
| ------- | -------- |
| `gyoza <namespace> <command>` for grouped commands | `gyoza generate env`, `gyoza init config`, `gyoza drizzle migrate` |
| `gyoza <command>` for standalone utilities | `gyoza update`, `gyoza build`, `gyoza lint` |

Namespace keys in the registry are the argv tokens — keep them short, lowercase, no hyphens. Flags follow POSIX convention: short `-f`, long `--flag`, value `--flag <value>`.

### Guidelines

- Resolve all paths from `process.cwd()` so gyoza operates on the project it is run from, not its own install location.
- `process.exit(1)` on unrecoverable errors. Log a clear message first.
- Keep side effects reversible — write backups before overwriting files.
- For commands with multiple sub-operations, co-locate shared helpers in a subdirectory: `src/commands/drizzle/` with an `index.ts` that exports the `Command` objects.

---

## Architecture

```text
gyoza/
├── cli.ts                      ← entry point; loads config, injects custom scripts, dispatches
├── index.ts                    ← barrel export
├── src/
│   ├── config.ts               ← GyozaConfig, CustomScripts, loadConfig
│   ├── gyoza.ts                ← factory: gyoza(), Command, CommandGroup, GyozaNode
│   └── commands/
│       ├── index.ts            ← root registry (the top-level gyoza() call)
│       ├── build.ts            ← build command
│       ├── update.ts           ← update command
│       ├── generate/
│       │   ├── index.ts        ← generateGroup + KnownGenerateCommand type
│       │   └── env.ts          ← generate env
│       └── init/
│           ├── index.ts        ← initGroup + KnownInitCommand type
│           ├── config.ts       ← init config
│           └── eslint.ts       ← init eslint
└── package.json
```

`cli.ts` walks `process.argv` down the command tree recursively. Each node is either a `Command` (runs immediately) or a `CommandGroup` (recurses into the next arg). Help is printed at whatever depth `--help` appears.

---

## Development

```bash
# type-check
bun run typecheck

# lint
bun run lint

# run a command locally
bun run cli.ts help
bun run cli.ts generate env
```
