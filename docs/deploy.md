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
3. **Install.** Runs `bun install` only if `bun.lock` is among the pulled changes.
   If that install changed gyoza's own version, the rest of the deploy is handed
   to the newly installed gyoza (see [Self-update during a deploy](#self-update-during-a-deploy)).
   If the pull changed `gyoza.config.ts`, the config is reloaded and re-validated
   **after** the install, by the gyoza that will run the rest of the deploy. That
   way a config that uses a feature of the gyoza version `bun.lock` brings in is
   never rejected by the older one. Every later step uses the new values (a
   renamed `deploy.service`, new build steps, …). Only then, if `deploy.service`
   is still unset, it asks whether to finish without a restart, so pushing a
   config that adds the service and deploying it works in one run. Declining
   leaves the pull and install in place; a re-run picks up from there.
4. **Server preflight.** Runs `deploy.preflight`, if it is configured: what the
   OS must provide for the app (see [Server preflight](#server-preflight)). When
   `deploy.service` is set, gyoza adds its own restart checks. A failing check
   stops the deploy here, so the **old service keeps running**.
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

`deploy.preflight` answers one question: **can this server run the app?** It
checks what the operating system has to provide and the app can't provide for
itself, before anything is migrated, built or restarted.

It has two parts:

- `deps`: software the host provides. That can be a binary, a system library, or
  an external service such as postgres or valkey, checked for presence and version.
- `checks`: the state of the host, such as a mounted share, a writable directory
  or free space.

### What belongs in a preflight

Ask what the fix would be if the entry failed. When the fix is on the server
(install a package, mount a share, free some disk, upgrade postgres), the entry
belongs. When the fix is a change to the repo, it doesn't.

| Belongs | Doesn't belong |
| --- | --- |
| A binary or library the app or its build calls: `ffmpeg`, `unzip`, `libheif`, `cargo` | Settings the app depends on *inside* a service: redis `maxmemory-policy`, postgres `max_connections`, a database role's privileges |
| A minimum version of an external service: postgres `>=18`, valkey `>=7.2` | Anything the migrations create, such as postgres extensions or tables. A migration that can't run fails at the migrate step with the database's own error, before anything else changes |
| A storage path is mounted, writable and has room | Env variables. The app's `server/env.ts` already validates them at startup |
| A runtime plugin whose absence only shows up later, in production (an HEVC decoder for libheif) | Feature toggles or optional integrations. The app decides whether they are on |
| | The app's own port, units, sudo rights, git state or bun. gyoza checks what it needs itself (see [Checks gyoza runs itself](#checks-gyoza-runs-itself)) |

Build tools such as `cargo` or a C compiler do belong, even though the build
would fail without them anyway. Migrations run before the build, so without the
preflight a missing compiler is found only after the schema has already moved.

A preflight is usually a dozen one-line entries. If it needs helper functions,
client libraries or caches, it is probably checking how the app is configured,
not what the OS provides.

```ts
import { check, defineConfig } from 'gyoza';

export default defineConfig({
  deploy: {
    service: 'app',
    preflight: {
      deps: {
        // External services: ask the running server for its version (see Versions)
        postgres: {
          command: 'psql',
          version: { range: '>=18', probe: (ctx) => ['psql', '-d', ctx.serverEnv.DATABASE_URL, '-tAc', 'show server_version'] },
        },
        valkey: {
          command: 'valkey-cli',
          version: {
            range: '>=7.2',
            probe: (ctx) => ['valkey-cli', '-u', ctx.serverEnv.REDIS_URL, 'INFO', 'server'],
            match: 'redis_version:{version}',
          },
        },
        // Host software
        ffmpeg:  { version: '>=6' },               // command defaults to the key
        unzip:   {},                               // presence only
        libheif: { pkgConfig: 'libheif', version: '>=1.16' },
        vips:    { library: 'libvips', onFail: 'warn' },
      },
      checks: {
        media:    (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT),
        writable: (ctx) => check.writable(ctx.serverEnv.STORAGE_ROOT),
        space:    { run: (ctx) => check.freeSpace(ctx.serverEnv.STORAGE_ROOT, '20GB'), onFail: 'warn' },
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

### External services: probe the server, not the client

`psql --version` and `valkey-cli --version` report the **client** installed on
this host. That says nothing about the server the app connects to, which may be
on another machine. To check the server, make `probe` a function that builds the
command from the app's own connection URL:

```ts
postgres: {
  command: 'psql',            // the client must be installed here
  version: {
    range: '>=18',
    probe: (ctx) => ['psql', '-d', ctx.serverEnv.DATABASE_URL, '-tAc', 'show server_version'],
  },
},
valkey: {
  command: 'valkey-cli',      // or redis-cli
  version: {
    range: '>=7.2',
    probe: (ctx) => ['valkey-cli', '-u', ctx.serverEnv.REDIS_URL, 'INFO', 'server'],
    match: 'redis_version:{version}',
  },
},
```

- One entry proves three things: the client is installed, the server is reachable,
  and the server is new enough. No separate "is it running" check is needed.
- Return an **array**. It is spawned without a shell, so a URL needs no quoting.
  A returned string runs through `sh -c`, the same as a string `probe`.
- A custom probe has to **exit 0**. A failed connection fails the dep with the
  first line of the error. It is never read as a version, even though an IP
  address such as `10.0.0.5` looks like one.
- Passwords in `scheme://user:password@host` URLs are masked as `***` in the
  report. While the probe runs, its command line is visible to other users in
  `ps`. On a shared host, keep the password in `~/.pgpass` or the client's own
  config instead of the URL.
- Valkey reports a redis-compatible `redis_version` (7.2.4 for valkey 8), which
  is what redis clients such as BullMQ compare against. Match on
  `valkey_version:{version}` to check valkey's own version instead.
- The `.env` variable must be set. Otherwise the dep fails as
  `DATABASE_URL is not set in server/.env`.

An invalid range is a config error. gyoza checks ranges itself, because
`Bun.semver.satisfies` treats an unparseable range as a match.

### `anyOf`

`anyOf` passes when **any** alternative passes. The report names the alternative
that matched, or explains why each one failed. Only the group's `onFail` counts,
and `anyOf` can't be nested.

### Built-in checks

| Check | Passes when |
| --- | --- |
| `check.mounted(path, { fstype? })` | `path` is on a mounted filesystem: a mount point itself, or anywhere inside one (`/mnt/apps/my-app` on a share mounted at `/mnt/apps`). It fails when the deepest mount above `path` is `/`, which is where the path ends up when the share isn't mounted. `fstype` (e.g. `'nfs4'`) is checked against that containing mount, and is worth setting when `/mnt` itself is a separate local disk. Reads `/proc/self/mountinfo` and never touches the mount, so a hung share can't hang the deploy. Symlinks aren't resolved, so pass the real path |
| `check.writable(path)` | `path` is a directory the deploy user can write to. Runs `test` with a timeout, so a hung share fails instead of hanging. Pair it with `mounted` for a share: an unmounted share's empty mount point can still be writable |
| `check.freeSpace(path, '20GB')` | at least that much is free, via `df` with a timeout. `KB`/`MB`/`GB`/`TB` are decimal, `K`/`G`/`GiB` are binary, and a number is bytes |
| `check.portFree(3000)` | nothing *else* listens on the TCP port (see below) |
| `check.serviceActive('postgresql')` | `systemctl is-active` reports `active`. Only for a service on this host. A version probe against the server already proves it is up |
| `check.commandSucceeds('…')` | the command exits 0 |

`portFree` is for a port some *other* software on the host must leave free. The
app's own `PORT` rarely needs it: a conflict there shows up as soon as the
service starts. It treats the service being deployed as expected. The old process is still
running and still holds its port, so a listener inside one of the `deploy.service`
units passes. `ss` shows process IDs only for processes the deploy user owns. When
the listener isn't visible and a `deploy.service` unit is active, gyoza assumes the
listener is that unit, and the report line says so.

### Checks gyoza runs itself

When `deploy.service` is set, every preflight ends with two checks of gyoza's
own. They run even when `deploy.preflight` is not configured, and
`--skip-preflight` skips them too. Don't add them to the config.

| Check | Passes when | On failure |
| --- | --- | --- |
| `systemd units` | every `deploy.service` unit is `loaded`: its unit file exists and systemd has read it | `fail`. A typo or an uninstalled unit makes the restart fail, and without this check that would happen only after migrate and build |
| `sudo restart` | `sudo -n -l systemctl restart <units…>` succeeds, so the exact restart gyoza runs needs no password. Passes when gyoza runs as root | `fail` without a TTY, where a password prompt would make the restart fail. `warn` in an interactive shell, where you can type the password |

```text
🔎  Preflight
  ✓ postgres       18.1 (>=18)
  ✓ systemd units  app.service, worker.service
  ✓ sudo restart   no password needed for systemctl restart app.service worker.service
```

gyoza also checks the git state, the `deploy` config and `bun install` as part of
the deploy itself, so a preflight never needs to.

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
  media:    (ctx) => check.mounted(ctx.serverEnv.STORAGE_ROOT),
  writable: (ctx) => check.writable(ctx.serverEnv.STORAGE_ROOT),
  space:    { run: (ctx) => check.freeSpace(ctx.serverEnv.STORAGE_ROOT, '20GB'), onFail: 'warn' },
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

#### Typed `serverEnv`

`ctx.serverEnv` gets its keys from the `Bun.Env` augmentation that the template
puts at the bottom of `server/env.ts`:

```ts
declare module 'bun' {
  interface Env extends ServerEnv {
    [key: string]: string | undefined;
  }
}
```

With that block in place, the editor autocompletes the variable names, and a
misspelled name is a type error instead of a failure at deploy time. Nothing in
`gyoza.config.ts` changes. An older project without the block gets an untyped
`serverEnv`; add the block to `server/env.ts` to get the names.

- Every value is typed `string`, even when the schema says otherwise. gyoza
  reads `.env` and never runs the Zod schema, so a
  `z.coerce.number()` field is still `'3000'`. Convert it yourself:
  `check.portFree(Number(ctx.serverEnv.PORT))`.
- An optional field is typed `string` as well, because reading it when it's
  unset throws. Test for it with `in` first, as above.
- A variable the schema doesn't declare is a type error. To read one anyway,
  cast: `(ctx.serverEnv as ProjectEnv).OTHER`.
- The names only come through when `gyoza.config.ts` and `server/env.ts` are
  checked by the same TypeScript program. The template's root `tsconfig.json`
  has no `include`, so it covers both.
- `frontendEnv` is untyped.

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

With several units, the entry must match the single command gyoza runs
(`systemctl restart app.service worker.service`). The preflight's `sudo restart`
check tests that exact command line, so a mismatch is caught before migrating.

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
then exits with that process's exit code. The new process loads and validates
the pulled config itself, asks about an unset `deploy.service`, and picks up at
**Server preflight**. The pull and the install already happened, so it doesn't
repeat them.

- Up to 0.16.0, the old gyoza validated a pulled `gyoza.config.ts` **before**
  installing. A config that used a feature of the incoming gyoza was rejected,
  and the deploy stopped with the pull applied but not installed. Run
  `bun install`, then `gyoza deploy` again. This can still happen on the deploy
  that upgrades a server *from* 0.16.0 or older, since that deploy runs the old
  code.
- A parent from 0.13.0–0.16.0 asks about an unset `deploy.service` before
  handing off, so the new gyoza asks a second time.

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
| Pulled `gyoza.config.ts` has a malformed `deploy` block | Exit 1 after the pull and install, before preflight — the service is **not** restarted |
| `cwd` is not a git work tree, or HEAD is detached | Exit 1 |
| Working tree has uncommitted changes | Exit 1 — commit or stash first |
| `deploy.service` / `deploy.migrate` unset in a non-interactive shell | Exit 1 naming the field and `--yes` |
| `git pull --ff-only` is not a fast-forward | Exit 1 — resolve the divergence manually |
| A `deploy.preflight` entry with `onFail: 'fail'` (the default) fails | Exit 1 after every check has run. Nothing is migrated, built or restarted |
| A `deploy.service` unit isn't loaded, or the restart would need a password with no TTY | Exit 1 at the preflight, before migrate |
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
