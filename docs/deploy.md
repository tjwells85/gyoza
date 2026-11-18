# gyoza deploy

Orchestrates a full server-side deployment: pull, reinstall, migrate, build,
restart.

```bash
gyoza deploy         # run the deploy
gyoza deploy --dry   # print the plan, change nothing
gyoza deploy -y      # run it without any confirmation prompts
gyoza deploy --skip-preflight # don't run deploy.preflight checks
```

No new commits is not an error: the deploy still migrates, builds and restarts,
so `gyoza deploy` doubles as a one-step "rebuild and restart". The old `--force`
flag that used to enable this is still accepted, but it only prints a deprecation
notice.

> `gyoza build` produces `build/`.
> `gyoza deploy` runs `gyoza build` as one step of shipping it to a running server.

---

## Why this exists

`gyoza build` is only half of a release. On the server you still have to pull the
new commit, run `bun install` when the lockfile moved, apply database migrations,
rebuild, and restart the systemd unit — in that order, every time. That sequence
lived in per-project scripts and drifted between projects. `gyoza deploy` makes
it one command driven by two config fields.

This is the only gyoza command that runs **on the server** and the only one that
shells out to `git`. It still operates on `process.cwd()` — the project you run
it from.

---

## What it does

1. **Preflight.** Validates the `deploy` config, confirms `cwd` is a git work tree
   on a branch (not detached), and that the working tree is clean.
2. **Pull.** `git pull --ff-only origin <current-branch>`. Fast-forward only — if
   the server checkout has diverged, the pull aborts and nothing else runs.
   If the pull changed `gyoza.config.ts`, the config is reloaded and re-validated
   here, so every later step uses the new values (a renamed `deploy.service`,
   new build steps, …). Only then, if `deploy.service` is still unset, it asks
   whether to finish without a restart — so pushing a config that adds the
   service and deploying it works in one run. Declining leaves the pull in
   place; a re-run picks up from there.
3. **Install.** Runs `bun install` only if `bun.lock` is among the pulled changes.
   If that install changed gyoza's own version, the rest of the deploy is handed
   to the newly installed gyoza (see [Self-update during a deploy](#self-update-during-a-deploy)).
4. **Server preflight.** Runs `deploy.preflight`, if it is configured: required
   software and server-state checks (see [Server preflight](#server-preflight)).
   A failing check stops the deploy here, so the **old service keeps running**.
5. **Migrate.** Runs `deploy.migrate` (see below).
6. **Build.** Runs `gyoza build` in-process. A build failure stops the deploy here,
   so the **old service keeps running**.
7. **Restart.** `sudo systemctl restart <units…>` for `deploy.service`.

```text
$ gyoza deploy
⬇  Pulling origin/main (fast-forward only)...
Updating a1b2c3d..e4f5a6b
 Fast-forward
 server/db/0007_add_index.sql | 3 +++
 bun.lock                     | 8 ++++----

📦  bun.lock changed — running bun install...

🔎  Preflight
  ✓ postgres  16.4 (>=15)
  ✓ cache     valkey 8.0.1 (>=7.2) — one of redis, valkey
  ✓ media     /mnt/media (nfs4 from nas:/export/media)
🗄  Running migrations (bun run db:migrate)...
🏗  Building...
✅  Build completed successfully in 6.20s
♻  Restarting app.service...
✅  Deployed main  a1b2c3d → e4f5a6b
```

---

## Configuration

Both fields live under `deploy` in `gyoza.config.ts`. See the
[gyoza.config.ts reference](config.md#deploy-config) for the full shape.

```ts
import { defineConfig } from 'gyoza';

export default defineConfig({
  deploy: {
    migrate: 'db:migrate',        // a package.json script, or a callback
    service: 'app',               // 'app' | 'app.service' | ['app', 'worker']
  },
});
```

If a field is missing, `gyoza deploy` prompts before continuing. In a
non-interactive shell (CI, a systemd oneshot, a git hook) it cannot prompt, so it
**aborts** — set the field or pass `--yes`.

---

## Server preflight

`deploy.preflight` lists what the server needs before this project can be
migrated, built and restarted. It has two parts:

- `deps`: external software, such as postgres, redis or valkey, or a system
  library.
- `checks`: server state, such as a mounted share, free space or a free port.

The common cases each take one line.

```ts
import { check, defineConfig } from 'gyoza';

export default defineConfig({
  deploy: {
    service: 'app',
    preflight: {
      deps: {
        postgres: { command: 'psql', version: '>=15' },
        bun:      { version: '>=1.3' },            // command defaults to the key
        cache: {
          anyOf: {                                  // redis OR valkey
            redis:  { command: 'redis-server',  version: '>=7' },
            valkey: { command: 'valkey-server', version: '>=7.2' },
          },
        },
        libheif: { pkgConfig: 'libheif', version: '>=1.16', onFail: 'warn' },
        vips:    { library: 'libvips' },
      },
      checks: {
        media: check.mounted('/mnt/media'),
        space: { run: check.freeSpace('/mnt/media', '20GB'), onFail: 'warn' },
        port:  check.portFree(3000),
        pg:    check.serviceActive('postgresql'),
        uploads: {
          name: 'Uploads writable',
          run: async ({ exec }) => (await exec('test -w /mnt/media/uploads')).exitCode === 0,
        },
      },
    },
  },
});
```

### What happens on a failure

Every dependency is checked first, then every check, in the order written. All of
them run before gyoza decides anything, so one pass lists every problem. Each one has an
`onFail`:

| `onFail` | On failure |
| --- | --- |
| `'fail'` (default) | Printed with `✗` to stderr. Once everything has run, the deploy exits 1 before migrating, building or restarting |
| `'warn'` | Printed with `⚠` and the deploy continues |

`-y` never turns a `fail` into a pass. To deploy past a failing preflight on purpose,
pass `--skip-preflight`.

The preflight runs **after** `bun install`. When the install updates gyoza itself,
the new gyoza runs the preflight, after the
[handoff](#self-update-during-a-deploy). A preflight failure leaves the
pull and the install in place, the same way a build failure does. The service is not touched.

### `deps`: how gyoza finds a dependency

Each dependency has one **source**. The source decides how gyoza checks that the
dependency is present and, when you give a `version`, how it finds the installed version.

| Source | Present when | Default version probe |
| --- | --- | --- |
| `command: 'psql'` (default: the key) | the binary is on `PATH`, or the absolute path exists | `<command> --version` |
| `pkgConfig: 'libheif'` | `pkg-config --exists` succeeds | `pkg-config --modversion` |
| `library: 'libvips'` | `ldconfig -p` lists `libvips.so…` | none (presence only) |
| `exists: (ctx) => boolean` | your function returns true | none (set `probe` or `get`) |

`pkgConfig` only sees libraries whose `-dev` / `-devel` package is installed, because
that package ships the `.pc` file. A server with only the runtime package installed
should use `library` instead.

### Versions

`version` is a semver range, such as `'>=15'`, `'>=7 <9'` or `'^1.16'`. With only a
range, gyoza runs the default probe and takes the **first `N.N[.N]` number in the
output**, from stdout or stderr. That works for psql, redis, valkey, node, bun,
git and ffmpeg without any further setup. Partial versions (`16.4`) are padded,
and distro suffixes (`6.1.1-3ubuntu5`) are dropped.

When the default probe or match doesn't fit, use the object form:

```ts
weird: {
  command: 'mytool',
  version: {
    range: '>=2',
    probe: ['mytool', 'info'],     // or a string, which runs through sh -c
    match: 'Build {version} (',    // a template: the {version} marker is where the number sits
    // match: /Build (\S+)/,       // or a RegExp with the version in capture group 1
  },
},
```

`get: (ctx) => string | undefined` is the last resort: return the version yourself.

> **The postgres server vs `psql`.** `psql --version` is the **client** version. To
> check the server, query it:
> `version: { range: '>=15', probe: 'psql "$DATABASE_URL" -tAc "show server_version"' }`.

An invalid range is a config error. gyoza checks ranges itself, because
`Bun.semver.satisfies` treats an unparseable range as a match.

### `anyOf`

`anyOf` passes when **any** alternative passes. The report names the alternative
that matched, or explains why each one failed. Only the group's `onFail` counts,
and `anyOf` can't be nested.

### Built-in checks

| Check | Passes when |
| --- | --- |
| `check.mounted(path, { fstype? })` | `path` is a mount point (optionally of that filesystem type). Reads `/proc/self/mountinfo` and never touches the mount, so a hung share can't hang the deploy |
| `check.freeSpace(path, '20GB')` | at least that much is free, via `df` with a timeout. `KB`/`MB`/`GB`/`TB` are decimal, `K`/`G`/`GiB` are binary, and a number is bytes |
| `check.portFree(3000)` | nothing *else* listens on the TCP port (see below) |
| `check.serviceActive('postgresql')` | `systemctl is-active` reports `active` |
| `check.commandSucceeds('…')` | the command exits 0 |

`portFree` treats the service being deployed as expected. The old process is still
running and still holds its port, so a listener inside one of the `deploy.service`
units passes. `ss` shows process IDs only for processes the deploy user owns. When
the listener isn't visible and a `deploy.service` unit is active, gyoza assumes the
listener is that unit, and the report line says so.

### Custom checks

A check is a function, or `{ name?, run, onFail? }` when you need a label or a
different `onFail`. `run` receives the
[migrate context](config.md#deploymigratecontext) plus:

- `services`: the normalized `deploy.service` units.
- `exec(cmd, { timeoutMs? })`: runs a command with a 10 s default timeout and never
  throws. A string runs through `sh -c`.
- `serverEnv` / `frontendEnv`: the project's env (see below).

`run` returns `true` / `false`, or `{ ok, detail }` to put the measured value in
the report. It can also return **another check**, which then runs with the same
context. That form lets a built-in check use a value from the env. A thrown error
counts as a failure, with the error's message as the detail. Each check is
limited to 30 s.

### Checks that read the env

Paths, ports and hosts often live in the project's `.env` rather than in
`gyoza.config.ts`. Read them from the context and return a built-in check:

```ts
checks: {
  media: (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT),
  space: { run: (ctx) => check.freeSpace(ctx.serverEnv.STORAGE_ROOT, '20GB'), onFail: 'warn' },
  port:  (ctx) => check.portFree(Number(ctx.serverEnv.PORT)),
},
```

- `serverEnv` is `server/.env`, layered over the `.default()` values in
  `server/env.ts`. A variable that only has a default still resolves.
- `frontendEnv` is `frontend/.env`.
- Values are what the app sees. gyoza removes an `export` prefix, surrounding
  quotes, and a trailing `# comment` after an unquoted value. Every value is a
  string, so convert it where a number is needed.
- **Reading a variable that isn't set throws**, so the check fails with
  `✗ media  STORAGE_ROOT is not set in server/.env`. Without this, a missing
  variable would quietly become `check.mounted(undefined)`. To handle an
  optional variable, test for it first:
  `'BACKUP_ROOT' in ctx.serverEnv ? check.mounted(ctx.serverEnv.BACKUP_ROOT) : true`.
- The `.env` files are read from disk when the preflight runs, which is after the
  pull. They are usually gitignored, so a pull doesn't change them, but a pulled
  `server/env.ts` can change the defaults.
- `deps` functions (`exists`, `version.get`) get the same context.

Checks should be **read-only**, because `--dry` runs them too.

---

## The pull is fast-forward only

`git pull` without `--ff-only` will create a merge commit when the server tree has
any commit the remote doesn't — an in-place hotfix, a half-finished previous
deploy, CRLF churn. That merge is almost never what you want on a deploy box.
`--ff-only` turns divergence into a loud failure instead. Resolve it by hand
(`git reset --hard origin/<branch>` if the checkout is disposable) and re-run.

---

## When migrations run

`deploy.migrate` runs on **every** deploy when it is set — the assumption is that
your migration tool (drizzle-kit, prisma, etc.) is a no-op when nothing is
pending.

- **string** — treated as a `package.json` script and run as `bun run <name>`. A
  name that isn't in `scripts` aborts the deploy.
- **callback** — called with `{ projectRoot, changedFiles, fromRef, toRef }` where
  `changedFiles` is the pulled diff and `fromRef` / `toRef` are the HEAD shas
  either side of the pull. A thrown error aborts the deploy.

If `deploy.migrate` is **not** set and the pull changed one or more `.sql` files,
`gyoza deploy` warns and asks whether to continue without migrating (default no).

---

## Service restart

`sudo systemctl restart` is used — the units are treated as **system** units. A
string or an array is accepted; an array restarts every unit in a single
`systemctl` call. Names without a `.` suffix get `.service` appended.

For an unattended deploy the invoking user needs a NOPASSWD sudoers entry scoped
to the restart, e.g.:

```text
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart app.service
```

---

## Self-update during a deploy

When you `gyoza upgrade` locally and commit the new `bun.lock`, the server's
deploy installs that newer gyoza partway through. The process doing the
deploy is still the old gyoza, though, and it would run migrate, build and
restart with old code.

So after `bun install`, `gyoza deploy` checks whether its own install changed.
It compares the commit in bun's `.bun-tag` file, or the `version` if that file
is missing. If the install changed, it starts the new
`node_modules/gyoza/cli.ts` with the pulled range (`<from>..<to>`) and `--yes`,
if you passed it, plus `--skip-preflight` if the new version understands it. It
then exits with that process's exit code. The new process picks up at
**Server preflight**, with a fresh config load. The pull, the install and
the no-restart confirmation already happened, so it doesn't repeat them.

```text
📦  bun.lock changed — running bun install...
🔁  bun install moved gyoza 0.12.0 (03d9105) → 0.13.0 (6b836bc) — handing the deploy to the new version...
🔁  Resuming deploy in gyoza 0.13.0 (6b836bc)...

🔎  Preflight
  ✓ postgres  16.4 (>=15)
🗄  Running migrations (bun run db:migrate)...
```

- A git install (`github:…`) is compared by commit, so a commit without a
  version bump still hands off. `.bun-tag` is an undocumented bun file. If it's
  missing, or for a non-git install, detection falls back to `version`, and an
  unbumped change doesn't hand off.
- A downgrade to a release older than 0.12.0 can't take a handoff. That deploy
  finishes in the running version and prints a warning.
- The deploy that first installs 0.12.0 is still run by the older gyoza, which
  has no handoff. Handoffs start with the deploy after that.

---

## Flags

| Flag | Effect |
| --- | --- |
| `--dry` | Fetch `origin`, print the full plan, run the preflight checks, change nothing else |
| `-y, --yes` | Skip every confirmation prompt (deploys without a restart if `deploy.service` is unset). Does not bypass a failing preflight |
| `--skip-preflight` | Don't run `deploy.preflight` |

---

## Errors

| Situation | Result |
| --- | --- |
| `deploy` config malformed (numeric `service`, empty `migrate`, …) | Exit 1 before anything is pulled |
| Pulled `gyoza.config.ts` has a malformed `deploy` block | Exit 1 after the pull, before install — the service is **not** restarted |
| `cwd` is not a git work tree, or HEAD is detached | Exit 1 |
| Working tree has uncommitted changes | Exit 1 — commit or stash first |
| `deploy.service` / `deploy.migrate` unset in a non-interactive shell | Exit 1 naming the field and `--yes` |
| `git pull --ff-only` is not a fast-forward | Exit 1 — resolve the divergence manually |
| A `deploy.preflight` entry with `onFail: 'fail'` (the default) fails | Exit 1 after every check has run. Nothing is migrated, built or restarted |
| `deploy.preflight` is malformed (invalid range, two sources, …) | Exit 1 before anything is pulled |
| `bun install`, the migration, or `sudo systemctl restart` fails | Exit 1 at that step |
| `gyoza build` fails | Exit 1 — the service is **not** restarted, old process keeps serving |

---

## Notes

Runs against `process.cwd()`, like everything except `gyoza upgrade`. The one
exception is the self-update check, which reads gyoza's own install location.

A failed deploy is **not** rolled back — the pull stays applied. Re-run
`gyoza deploy` once the cause is fixed; the pull step is a no-op the second time
and the remaining steps proceed.

`--dry` describes the **pre-pull** config. When the incoming commits touch
`gyoza.config.ts` the plan says so; the real deploy reloads it after pulling.
`--dry` also runs the **pre-pull** preflight, which answers "would this server
deploy right now?". A failing check is reported, and `--dry` still exits 0.

Only `gyoza.config.ts` itself is reloaded. A local module it imports (say a
`build-steps.ts` helper) stays at its pre-pull version for the rest of that run;
re-run `gyoza deploy` if such a file changed.
