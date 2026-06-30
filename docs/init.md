# gyoza init

Project initialization and migration commands. All subcommands operate on the project root where they are run (`process.cwd()`), not on gyoza's own install location.

---

## `gyoza init scripts`

Upserts the four canonical gyoza scripts in the project root `package.json` and removes legacy per-project script files left over from `hono-react-template`.

```bash
gyoza init scripts        # apply changes
gyoza init scripts --dry  # preview in console, touch nothing
```

### Target scripts

| Key              | Command                 |
| ---------------- | ----------------------- |
| `build`          | `gyoza build`           |
| `update:all`     | `gyoza update`          |
| `update:latest`  | `gyoza update --latest` |
| `generate:env`   | `gyoza generate env`    |

### Skip / replace / add logic

For each target script:

- If an existing script with that name already calls `gyoza` anywhere in its value → **skipped** (assumed customised for the project — not overwritten).
- If the script exists but its value doesn't call `gyoza` → **replaced**.
- If the script key is absent → **added**.

### Legacy 'env' script removal

Any script key that contains `'env'` (case-insensitive) and is not one of the target keys above is **removed**, regardless of its value. This standardizes all env-related scripts to the canonical `generate:env` key — even scripts like `"env:generate": "gyoza generate env"` that already call gyoza under the old naming convention are replaced.

### `./scripts/` folder cleanup

If a `./scripts/` folder exists in the project root, `build.ts`, `prepare.ts`, and `update.ts` are deleted individually if present. After deletion, if the folder is empty it is removed. Other files in the folder are left untouched.

### `--dry` mode

Prints a two-section report to the console without touching any files. If nothing would change, prints `No changes needed.`

```text
Scripts (package.json):
  "build": "bun run scripts/build.ts" -> "build": "gyoza build"
  "env:generate": "bun run scripts/generate.ts" -> REMOVED
  "update:all": (none) -> "update:all": "gyoza update"
  "generate:env": (none) -> "generate:env": "gyoza generate env"

Script files:
  scripts/build.ts -> DELETED
  scripts/update.ts -> DELETED
  scripts/ -> DELETED (empty after removals)
```

---

## `gyoza init eslint`

Migrates `eslint.config.mts` files to `eslint.config.mjs` across all workspaces. Strips TypeScript-only `@ts-*` directives and adds a JSDoc `@type` annotation so ESLint type information is preserved in plain JS.

```bash
gyoza init eslint          # migrate all workspaces
gyoza init eslint --dry    # preview — writes eslint-migration.md, touches nothing
```

### Workspaces searched

In order: `./`, `frontend/`, `server/`, `shared/`

### `--dry` mode

Writes `eslint-migration.md` in the project root. The file has one `##` section per workspace. Each section contains either:

- `` `eslint.config.mts` not found `` — if no `.mts` exists in that workspace
- A fenced `js` code block with the fully-transformed output — if `.mts` exists

If a workspace has both `.mts` and `.mjs`, a blockquote note appears above the code block indicating it would be skipped in normal mode.

Run `--dry` first to review all transformations in one place before committing.

### Normal mode

Per workspace:

1. Skip silently if no `.mts` exists.
2. Skip with a `⚠` warning if `.mjs` already exists.
3. Otherwise: transform the `.mts` content, write `.mjs`, delete `.mts`.

After migration, if `eslint-migration.md` exists in the project root (from a previous `--dry` run), gyoza prompts `[Y/n]` to remove it (default: yes).

### Transformation rules

Applied in order to every file:

1. **Remove standalone `@ts-*` lines** — any line matching `/^\s*\/\/ @ts-\S+/` is dropped (`@ts-check`, `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error`).
2. **Strip inline `@ts-*` trailing comments** — removes `// @ts-\S+.*` (with a leading space) from the end of lines that also contain code.
3. **Inject JSDoc before `defineConfig(`** — inserts `/** @type {import('eslint').Linter.Config[]} */` on the line immediately before any line containing `defineConfig(`, unless that comment is already the previous non-blank line.
4. **Collapse consecutive blank lines** — runs of 2+ blank lines are reduced to one, cleaning up gaps left by removed directive lines.

---

## `gyoza init config`

Scaffolds a `gyoza.config.ts` in the project root. If an existing config using the legacy `export const buildSteps` format is detected, migrates it to the current format instead of failing.

```bash
gyoza init config
```

The generated file contains a commented example with `build.pre` and `build.post` hooks to get you started.

For the full `gyoza.config.ts` reference — all fields, types, and examples — see [config.md](config.md).
