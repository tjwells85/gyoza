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
├── package.json
├── tsconfig.json
├── cli.ts                  ← bin entry point, subcommand dispatcher
└── src/
    └── commands/
        ├── generate.ts     ← env file generator (ported from template)
        └── update.ts       ← dependency updater (ported from template)
```

No CLI framework (no commander, yargs, etc.) — a simple argument switch in
`cli.ts` is sufficient.

### CLI commands

| Invocation              | What it does                                      |
|-------------------------|---------------------------------------------------|
| `gyoza env:generate`    | Generate/update `.env` files from schema sources  |
| `gyoza update`          | Interactive dependency updater                    |
| `gyoza update --latest` | Update to latest versions (ignores semver range)  |
| `gyoza update -y`       | Skip confirmation prompt                          |
| `gyoza help`            | Print available commands                          |

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

The shebang line lets Bun execute the file directly as a bin script. Dispatch
on `process.argv[2]`.

```ts
#!/usr/bin/env bun

import { generateEnv } from './src/commands/generate.ts';
import { runUpdate } from './src/commands/update.ts';

const command = process.argv[2];

switch (command) {
  case 'env:generate':
    await generateEnv();
    break;

  case 'update':
    await runUpdate(process.argv.slice(3));
    break;

  case 'help':
  case undefined:
    console.log(`
gyoza — hono-react-template tooling

Commands:
  env:generate          Generate/update .env files from schema sources
  update                Interactive dependency updater
  update --latest       Update to latest versions
  update -y             Skip confirmation prompt
  help                  Show this message
    `.trim());
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "gyoza help" for available commands.');
    process.exit(1);
}
```

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
- [ ] Unknown commands print an error and exit 1
- [ ] `bunx tsc --noEmit` passes with zero errors
- [ ] `bun run lint` passes with zero errors and zero warnings

---

## Notes

- All path resolution uses `process.cwd()`, so gyoza always operates on the
  project it is run from, not its own install location.
- The package is `"private": true`. If it ever goes public, scope it as
  `@timw/gyoza` to avoid npm squatting on the unscoped name.
- `build.ts` and `migrate.ts` from the template are **not** in scope for this
  initial implementation.
