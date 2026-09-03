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
import { defineConfig } from 'gyoza';

export default defineConfig({
  build: {
    cleanInstall: false,
    typecheck: 'fail',
    lint: { onError: 'fail', onWarning: 'warn' },
    pre: {
      rustBuild: {
        name: 'Build Rust CLI',
        run: async () => {
          // runs before the frontend/server build
          return { changed: true, artifact: 'target/release/mycli' };
        },
      },
    },
    post: {
      copyCli: {
        name: 'Copy CLI binary',
        run: async ({ buildDir, results }) => {
          if (!results.pre.rustBuild.changed) return;
          await Bun.write(`${buildDir}/mycli`, Bun.file(results.pre.rustBuild.artifact));
        },
      },
    },
  },
});
```

Steps are declared as an **object**, not an array. The key identifies the step: it is where the step's return value lands in `results`, and TypeScript rejects duplicate keys for you.

### Fields

| Field          | Type                  | Default   | Description |
| -------------- | --------------------- | --------- | ----------- |
| `cleanInstall` | `boolean`             | `false`   | If `true`, removes all `node_modules` recursively and runs `bun install` before building |
| `typecheck`    | `TypeCheckLevel`      | `'off'`   | Runs `tsc --noEmit` before the build |
| `lint`         | `LintCheckLevel`      | `'off'`   | Runs `eslint .` before the build |
| `pre`          | `BuildStepMap`        | `{}`      | Steps that run after cleaning and before the frontend/server build |
| `post`         | `BuildStepMap`        | `{}`      | Steps that run after assembly |

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

### Build steps

```ts
interface BuildStepEntry {
  name?: string;                 // display label; defaults to the step's key
  run(ctx: BuildContext): unknown;
}

interface BuildContext {
  projectRoot: string;  // process.cwd() of the consuming project
  buildDir: string;     // absolute path to build/
  results: StepResults; // what earlier steps returned
}
```

`run` may be sync or async. Steps run in declaration order — object property order is insertion order in JavaScript, so the order you write is the order you get.

> Keys that are plain numbers (`"0"`, `"12"`) are rejected by the preflight check. JavaScript sorts numeric keys ahead of every other key, so such a step would not run where it appears.

### Step results

Whatever a step returns is filed under its key and handed to later steps as `ctx.results`. A step that returns nothing contributes no key.

```ts
run: async ({ results }) => { … }
```

| Reading from | `results.pre` | `results.post` |
| --- | --- | --- |
| a `pre` step | earlier `pre` steps, `unknown` | empty |
| a `post` step | **all `pre` steps, fully typed** | earlier `post` steps, `unknown` |

So a `post` step gets `results.pre.rustBuild.changed` typed exactly as the `pre` step returned it, with no annotations. This is the case the feature exists for — deciding in `post` whether work done in `pre` needs acting on.

Same-phase results are readable but typed `unknown`; narrow them yourself:

```ts
const previous = results.pre.earlierStep as { changed: boolean };
```

#### Why same-phase results aren't typed

Typing a phase's own results would mean the type inferred *from* that phase's step map is also referenced *inside* that same map's parameter positions. TypeScript breaks the resulting cycle by collapsing the reading step's own return type to `unknown`, which then surfaces as an error in whichever later step consumes that value — nowhere near the actual cause. A uniform rule with no landmine is worth more than same-phase typing that silently degrades.

### Deprecated: the array form

`pre` and `post` also accept arrays, which is what gyoza shipped before 0.7.0. They still work and still run in order, but array steps have no key, so they contribute nothing to `results` and get no typing. `gyoza build` prints a deprecation warning, and support will be removed in a future release. See [Migrating to the keyed form](#migrating-to-the-keyed-form).

The even older `build.steps` array with `phase: 'pre' | 'post'` fields is likewise still honoured, with a warning.

---

## Migrating to the keyed form

Two steps, each independently safe to land. The running example below is a config that builds a Rust CLI in `pre` and copies it in `post`.

### Where you're starting

```ts
import type { GyozaConfig } from 'gyoza';

export default {
  build: {
    typecheck: 'fail',
    pre: [
      {
        name: 'Build Rust CLI',
        run: async () => {
          const proc = Bun.spawn(['cargo', 'build', '--release'], { stdout: 'inherit' });
          await proc.exited;
        },
      },
    ],
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

`gyoza build` warns that the array form is deprecated. The copy runs on every build, whether or not `cargo` actually rebuilt anything.

### Step 1 — wrap in `defineConfig`

Change the import and wrap the exported object. **Nothing else moves** — the arrays stay exactly as they are.

```diff
- import type { GyozaConfig } from 'gyoza';
+ import { defineConfig } from 'gyoza';

- export default {
+ export default defineConfig({
    build: {
      typecheck: 'fail',
      pre: [ /* unchanged */ ],
      post: [ /* unchanged */ ],
    },
- } satisfies GyozaConfig;
+ });
```

`defineConfig` accepts the array form precisely so this can be its own step. Run `gyoza build` and confirm it still behaves — the array deprecation warning is still there, because you haven't addressed it yet.

### Step 2 — convert `pre` and `post` to keyed objects

Give each step a key. The key is an identifier you will reference in code, so make it short — `name` stays for display and is now optional.

Convert **both** `pre` and `post` in the same edit. Mixing an array with an object is a preflight error rather than a guess, so a half-done conversion fails the build immediately rather than behaving oddly.

```diff
  build: {
    typecheck: 'fail',
-   pre: [
-     {
-       name: 'Build Rust CLI',
-       run: async () => { … },
-     },
-   ],
+   pre: {
+     rustBuild: {
+       name: 'Build Rust CLI',
+       run: async () => { … },
+     },
+   },
-   post: [
-     {
-       name: 'Copy Rust CLI',
-       run: async ({ buildDir }) => { … },
-     },
-   ],
+   post: {
+     copyCli: {
+       name: 'Copy Rust CLI',
+       run: async ({ buildDir }) => { … },
+     },
+   },
  },
```

The deprecation warning is now gone. Behaviour is unchanged — steps still run in the order you wrote them.

### Step 3 (the payoff) — return something and use it

Now that steps have keys, `pre` can report what it did and `post` can act on it:

```ts
import { defineConfig } from 'gyoza';

export default defineConfig({
  build: {
    typecheck: 'fail',
    pre: {
      rustBuild: {
        name: 'Build Rust CLI',
        run: async () => {
          const before = Bun.file('target/release/mycli').lastModified;
          const proc = Bun.spawn(['cargo', 'build', '--release'], { stdout: 'inherit' });
          await proc.exited;
          const after = Bun.file('target/release/mycli').lastModified;
          return { artifact: 'target/release/mycli', changed: before !== after };
        },
      },
    },
    post: {
      copyCli: {
        name: 'Copy Rust CLI',
        run: async ({ buildDir, results }) => {
          if (!results.pre.rustBuild.changed) {
            console.log('  ✓ Rust CLI unchanged, skipping copy');
            return;
          }
          await Bun.write(`${buildDir}/mycli`, Bun.file(results.pre.rustBuild.artifact));
        },
      },
    },
  },
});
```

`results.pre.rustBuild` is typed as `{ artifact: string; changed: boolean }` — inferred from what the `pre` step returns, with no annotation. Rename the key and the `post` step stops compiling.

### Also on `build.steps`

If your config still has the oldest form — a single `build.steps` array whose entries carry `phase: 'pre' | 'post'` — split it first. Entries with `phase: 'pre'` go into `pre`, everything else into `post`, and the `phase` field is dropped:

```diff
- steps: [
-   { name: 'Write manifest', phase: 'pre', run: async () => {} },
-   { name: 'Deploy', phase: 'post', run: async () => {} },
- ],
+ pre:  { writeManifest: { name: 'Write manifest', run: async () => {} } },
+ post: { deploy:        { name: 'Deploy',         run: async () => {} } },
```

---

## `custom` config

Registers project-specific subcommands under `gyoza init` and `gyoza generate`.

```ts
import { defineConfig } from 'gyoza';

export default defineConfig({
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
});
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

## `deploy` config

Drives `gyoza deploy`. Both fields are optional; when one is missing, `gyoza deploy`
prompts (and aborts in a non-interactive shell). See [gyoza deploy](deploy.md) for
the full command.

```ts
import { defineConfig } from 'gyoza';

export default defineConfig({
  deploy: {
    // a package.json script name…
    migrate: 'db:migrate',

    // …or a callback for custom logic
    // migrate: async ({ projectRoot, changedFiles, fromRef, toRef }) => {
    //   await runMyMigrator(projectRoot);
    // },

    service: 'app',                 // or 'app.service', or ['app', 'worker']
  },
});
```

### Fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `migrate` | `string` or `(ctx: DeployMigrateContext) => unknown` | none — prompts | DB migration step. A string is run as `bun run <name>`; a callback is awaited. Runs on every deploy |
| `service` | `string` or `string[]` | none — prompts | systemd unit(s) restarted with `sudo systemctl restart`. Names without a `.` get `.service` appended; an array restarts all in one call |

### `DeployMigrateContext`

```ts
interface DeployMigrateContext {
  projectRoot: string;    // process.cwd()
  changedFiles: string[]; // paths from the pulled diff (git diff --name-only)
  fromRef: string;        // HEAD sha before the pull
  toRef: string;          // HEAD sha after the pull
}
```

---

## Full example

```ts
import { defineConfig } from 'gyoza';

export default defineConfig({
  build: {
    cleanInstall: false,
    typecheck: 'fail',
    lint: { onError: 'fail', onWarning: 'warn' },
    pre: {
      rustBuild: {
        name: 'Build Rust CLI',
        run: async () => {
          const proc = Bun.spawn(['cargo', 'build', '--release'], { stdout: 'inherit' });
          await proc.exited;
          const binary = Bun.file('target/release/mycli');
          return { artifact: 'target/release/mycli', builtAt: binary.lastModified };
        },
      },
    },
    post: {
      copyCli: {
        name: 'Copy Rust CLI',
        run: async ({ buildDir, results }) => {
          await Bun.write(`${buildDir}/mycli`, Bun.file(results.pre.rustBuild.artifact));
        },
      },
    },
  },
  deploy: {
    migrate: 'db:migrate',
    service: ['app', 'worker'],
  },
  custom: {
    init: {
      seed: async () => {
        // project-specific seed logic
      },
    },
  },
});
```
