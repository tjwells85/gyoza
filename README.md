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
  "env:generate":   "gyoza env:generate",
  "update:all":     "gyoza update",
  "update:latest":  "gyoza update --latest"
}
```

---

## Commands

### `env:generate`

Generates `server/.env` and `frontend/.env` from their respective schema files. Existing values are preserved. A `.env.backup` is written before any existing file is overwritten, and the file is restored if validation fails.

```bash
gyoza env:generate
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

### `help`

```bash
gyoza help
```

Prints all registered commands and their flags. Updated automatically as new commands are added.

---

## Developing New Commands

Gyoza uses a command registry. Each command is a file in `src/commands/` that exports a `Command` object. Adding a new command takes three steps — no changes to `cli.ts` required.

### Step 1 — Create the command file

Create `src/commands/<name>.ts`. Keep implementation details private; export only the `Command` object.

```ts
// src/commands/drizzle.ts
import type { Command } from '../types.ts';

const drizzleInit = async (args: string[]): Promise<void> => {
  const db = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'pg';
  console.log(`Scaffolding Drizzle ORM with ${db} driver...`);
  // install deps, write files, update package.json scripts
};

export const drizzleInitCommand: Command = {
  name: 'drizzle:init',
  description: 'Scaffold Drizzle ORM on the server workspace',
  flags: [
    { flag: '--db <driver>', description: 'Database driver: pg | mysql | sqlite (default: pg)' },
  ],
  run: drizzleInit,
};
```

### Step 2 — Register in the index

Add a one-line import and append to the array in [src/commands/index.ts](src/commands/index.ts):

```ts
import type { Command } from '../types.ts';
import { envGenerateCommand } from './generate.ts';
import { updateCommand } from './update.ts';
import { drizzleInitCommand } from './drizzle.ts'; // ← add import

export const commands: Command[] = [
  envGenerateCommand,
  updateCommand,
  drizzleInitCommand, // ← add here
];
```

That's it. `gyoza help` will automatically include the new command and its flags.

### The `Command` interface

```ts
// src/types.ts
export interface CommandFlag {
  flag: string;
  description: string;
}

export interface Command {
  name: string;
  description: string;
  flags?: CommandFlag[];
  run(args: string[]): Promise<void>;
}
```

`flags` is optional — omit it for commands with no options.

### Naming conventions

| Pattern                                   | Examples                                          |
| ----------------------------------------- | ------------------------------------------------- |
| `namespace:verb` for tool-scoped commands | `drizzle:init`, `drizzle:migrate`, `env:generate` |
| Plain verb for top-level utilities        | `update`, `lint`, `check`                         |

Flags follow POSIX convention: short `-f`, long `--flag`, value `--flag <value>`.

### Guidelines

- Resolve all paths from `process.cwd()` so gyoza operates on the project it is run from, not its own install location.
- `process.exit(1)` on unrecoverable errors. Log a clear message first.
- Keep side effects reversible — write backups before overwriting files.
- For commands with multiple sub-operations, co-locate shared helpers in a subdirectory: `src/commands/drizzle/` with an `index.ts` that exports the `Command` objects.

---

## Architecture

```text
gyoza/
├── cli.ts                      ← entry point; dispatches via registry
├── src/
│   ├── types.ts                ← Command and CommandFlag interfaces
│   └── commands/
│       ├── index.ts            ← registry (one line per command)
│       ├── generate.ts         ← env:generate
│       └── update.ts           ← update
└── package.json
```

`cli.ts` imports `commands` from the registry, resolves the command by name, and calls `run(args)`. The help text is derived from the registry at runtime — no manual sync needed.

---

## Development

```bash
# type-check
bun run typecheck

# lint
bun run lint

# run a command locally
bun run cli.ts help
bun run cli.ts env:generate
```
