# gyoza.config.ts

The optional project-level config file. Create it in your project root with:

```bash
gyoza init config
```

Gyoza loads it from `process.cwd()/gyoza.config.ts` at startup. If the file is absent, all defaults apply and the build runs with no extra steps.

---

## `build` config

Controls the production build (`gyoza build`).

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,
    typecheck: 'fail',
    lint: { onError: 'fail', onWarning: 'warn' },
    pre: [
      {
        name: 'Generate types',
        run: async ({ projectRoot }) => {
          // runs before the frontend/server build
        },
      },
    ],
    post: [
      {
        name: 'Copy CLI binary',
        run: async ({ buildDir }) => {
          await Bun.write(`${buildDir}/mycli`, Bun.file('target/release/mycli'));
        },
      },
    ],
  },
} satisfies GyozaConfig;
```

### Fields

| Field          | Type                  | Default   | Description |
| -------------- | --------------------- | --------- | ----------- |
| `cleanInstall` | `boolean`             | `false`   | If `true`, removes all `node_modules` recursively and runs `bun install` before building |
| `typecheck`    | `TypeCheckLevel`      | `'off'`   | Runs `tsc --noEmit` before the build |
| `lint`         | `LintCheckLevel`      | `'off'`   | Runs `eslint .` before the build |
| `pre`          | `BuildStep[]`         | `[]`      | Steps that run after cleaning and before the frontend/server build |
| `post`         | `BuildStep[]`         | `[]`      | Steps that run after assembly |

### `TypeCheckLevel`

```ts
type TypeCheckLevel = 'off' | 'warn' | 'fail';
```

- `'off'` — skip the check
- `'warn'` — print a summary of errors and continue
- `'fail'` — abort the build if any errors are found

### `LintCheckLevel`

```ts
type LintCheckLevel = 'off' | 'warn' | 'fail' | { onError: CheckAction; onWarning: CheckAction };
// CheckAction = 'warn' | 'fail'
```

The object form lets you control errors and warnings independently:

```ts
lint: { onError: 'fail', onWarning: 'warn' }
```

### `BuildStep`

```ts
interface BuildStep {
  name: string;
  run(ctx: BuildContext): Promise<void>;
}

interface BuildContext {
  projectRoot: string;  // process.cwd() of the consuming project
  buildDir: string;     // absolute path to build/
}
```

Steps in `build.pre` and `build.post` do not have a `phase` field — that was a deprecated pattern from the legacy `buildSteps` array. If you're migrating from the old format, `gyoza init config` will handle it automatically.

---

## `custom` config

Registers project-specific subcommands under `gyoza init` and `gyoza generate`.

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  custom: {
    init: {
      // gyoza init seed
      seed: async () => {
        console.log('Seeding database...');
      },
    },
    generate: {
      // gyoza generate types
      types: async () => {
        // generate TypeScript types from DB schema
      },
    },
  },
} satisfies GyozaConfig;
```

Each value is a plain function: `() => void | Promise<void>`.

### Invocation

```bash
gyoza init seed         # runs custom.init.seed
gyoza generate types    # runs custom.generate.types
```

### Collision rules

- **Built-in commands always win.** If a custom script name matches a built-in (`config`, `eslint`, `scripts` under `init`; `env` under `generate`), gyoza prints a warning at startup and ignores the custom entry.
- The collision check is runtime-only. TypeScript's index signature intersection rules make a compile-time guard for this pattern unworkable.

### `KnownInitCommand` / `KnownGenerateCommand`

These types are exported from gyoza and derived directly from the registry. They update automatically when new built-in commands are added:

```ts
import type { KnownInitCommand, KnownGenerateCommand } from 'gyoza';
// KnownInitCommand    = 'config' | 'eslint' | 'scripts'
// KnownGenerateCommand = 'env'
```

---

## Full example

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    cleanInstall: false,
    typecheck: 'fail',
    lint: { onError: 'fail', onWarning: 'warn' },
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
  custom: {
    init: {
      seed: async () => {
        // project-specific seed logic
      },
    },
  },
} satisfies GyozaConfig;
```
