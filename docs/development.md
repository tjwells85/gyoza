# Developing with gyoza

---

## Public API

Gyoza exports types from its root entry point for use in `gyoza.config.ts` and any tooling that extends it:

```ts
import type {
  BuildConfig, BuildContext, BuildStep,
  CheckAction, TypeCheckLevel, LintCheckLevel,
  GyozaConfig, CustomScripts,
  Command, CommandFlag, CommandGroup, GyozaNode,
} from 'gyoza';
```

| Export           | Description                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `GyozaConfig`    | Top-level config shape for `gyoza.config.ts`                                                |
| `BuildConfig`    | `build` section: `cleanInstall`, `typecheck`, `lint`, `pre`, `post`                         |
| `TypeCheckLevel` | `'off' \| 'warn' \| 'fail'` — controls `tsc --noEmit` pre-build check                       |
| `LintCheckLevel` | `'off' \| 'warn' \| 'fail' \| { onError, onWarning }` — controls `eslint .` pre-build check |
| `CheckAction`    | `'warn' \| 'fail'` — action taken when a check finds issues                                 |
| `BuildStep`      | A custom step: `name` and `run(ctx)`                                                        |
| `BuildContext`   | Passed to each `BuildStep.run`: `projectRoot`, `buildDir`                                   |
| `CustomScripts`  | `custom` section: `init` and `generate` maps of script functions                            |
| `Command`        | Leaf node: `description`, `flags?`, and `run`                                               |
| `CommandGroup`   | Branch node: `description` and `commands` record                                            |
| `GyozaNode`      | Union of `Command | CommandGroup`                                                           |
| `CommandFlag`    | A flag descriptor: `{ flag: string, description: string }`                                  |

---

## Developing new commands

Gyoza uses a command registry. Each command is a file in `src/commands/` that exports `description`, `run`, and optionally `flags`. Adding a command requires no changes to `cli.ts`.

Every command group is built with the `gyoza` factory, which injects a `cmd` helper:

```ts
import { gyoza } from '../../gyoza.ts';

export const myGroup = gyoza('Group description', (cmd) => ({
  subcommand: cmd('Subcommand description', runFn, optionalFlags),
  nested: gyoza('Nested group', (cmd) => ({
    deeper: cmd('Nested subcommand', runDeep),
  })),
}));
```

### Standalone command

For top-level commands with no subcommands (like `update`, `build`):

```ts
// src/commands/lint.ts
import type { CommandFlag } from '../gyoza.ts';

export const description = 'Lint the monorepo';
export const flags: CommandFlag[] = [
  { flag: '--fix', description: 'Auto-fix fixable issues' },
];

export const run = async (args: string[]): Promise<void> => {
  // implementation
};
```

Register in [src/commands/index.ts](../src/commands/index.ts):

```ts
import * as lint from './lint.ts';

export const registry = gyoza('gyoza — ...', (cmd) => ({
  // existing entries...
  lint: cmd(lint.description, lint.run, lint.flags),
}));
```

### Namespace command

For commands under a namespace (`gyoza generate types`, `gyoza drizzle migrate`, etc.):

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
import * as types from './types.ts';

export const generateGroup = gyoza('Code generation commands', (cmd) => ({
  env:   cmd(env.description, env.run),
  types: cmd(types.description, types.run),
}));
```

`gyoza generate --help` automatically shows the new command.

### Adding a new namespace

Create the directory, an `index.ts` that calls `gyoza()`, and register the group in the root registry:

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
  drizzle:  drizzleGroup,
  update:   cmd(...),
  build:    cmd(...),
}));
```

`gyoza drizzle --help` immediately works.

### The `gyoza` factory

```ts
export const gyoza = (
  description: string,
  builder: (cmd: CommandFactory) => Record<string, GyozaNode>,
): CommandGroup
```

The injected `cmd` helper:

```ts
cmd(description: string, run: Handler, flags?: CommandFlag[]): Command
```

`flags` is optional — omit it for commands with no options.

### Naming conventions

| Pattern | Examples |
| ------- | -------- |
| `gyoza <namespace> <command>` for grouped commands | `gyoza generate env`, `gyoza init config`, `gyoza drizzle migrate` |
| `gyoza <command>` for standalone utilities | `gyoza update`, `gyoza build` |

Namespace keys in the registry are the argv tokens — keep them short, lowercase, no hyphens. Flags follow POSIX convention: short `-f`, long `--flag`.

### Guidelines

- Resolve all paths from `process.cwd()` so gyoza operates on the project it is run from, not its own install location.
- `process.exit(1)` on unrecoverable errors. Log a clear message first.
- Keep side effects reversible — write backups before overwriting files.

---

## Architecture

```text
gyoza/
├── cli.ts                      ← entry point; loads config, injects custom scripts, dispatches
├── index.ts                    ← barrel export
├── src/
│   ├── config.ts               ← GyozaConfig, CustomScripts, loadConfig
│   ├── gyoza.ts                ← factory: gyoza(), Command, CommandGroup, GyozaNode
│   ├── workspaces.ts           ← workspace discovery, catalog read/write helpers
│   ├── catalog.ts              ← catalog-mode arg parsing, change application
│   ├── bunfig.ts               ← bunfig.toml minimumReleaseAge policy
│   ├── version.ts              ← bun info resolution, semver compare, release-age gate
│   ├── prompt.ts               ← shared Y/n confirmation
│   └── commands/
│       ├── index.ts            ← root registry (the top-level gyoza() call)
│       ├── build.ts            ← build command
│       ├── add.ts              ← add command
│       ├── remove.ts           ← remove command
│       ├── update.ts           ← update command
│       ├── upgrade.ts          ← upgrade command (gyoza self-update)
│       ├── generate/
│       │   ├── index.ts        ← generateGroup + KnownGenerateCommand type
│       │   └── env.ts          ← generate env
│       └── init/
│           ├── index.ts        ← initGroup + KnownInitCommand type
│           ├── config.ts       ← init config
│           ├── eslint.ts       ← init eslint
│           └── scripts.ts      ← init scripts
└── package.json
```

`cli.ts` walks `process.argv` down the command tree recursively. Each node is either a `Command` (runs immediately) or a `CommandGroup` (recurses into the next arg). Help is printed at whatever depth `--help` appears.

---

## Development

```bash
# Type-check
bun run typecheck

# Lint
bun run lint

# Run commands locally
bun run cli.ts help
bun run cli.ts generate env
bun run cli.ts init --help
```
