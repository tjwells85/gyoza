# gyoza deploy

Orchestrates a full server-side deployment: pull, reinstall, migrate, build,
restart.

```bash
gyoza deploy         # run the deploy
gyoza deploy --dry   # print the plan, change nothing
gyoza deploy -y      # run it without any confirmation prompts
gyoza deploy --force # rebuild and restart even if the pull brought nothing new
```

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
   on a branch (not detached), and that the working tree is clean. If
   `deploy.service` is unset it asks whether to finish without a restart.
2. **Pull.** `git pull --ff-only origin <current-branch>`. Fast-forward only — if
   the server checkout has diverged, the pull aborts and nothing else runs.
3. **Install.** Runs `bun install` only if `bun.lock` is among the pulled changes.
4. **Migrate.** Runs `deploy.migrate` (see below).
5. **Build.** Runs `gyoza build` in-process. A build failure stops the deploy here,
   so the **old service keeps running**.
6. **Restart.** `sudo systemctl restart <units…>` for `deploy.service`.

```text
$ gyoza deploy
⬇  Pulling origin/main (fast-forward only)...
Updating a1b2c3d..e4f5a6b
 Fast-forward
 server/db/0007_add_index.sql | 3 +++
 bun.lock                     | 8 ++++----

📦  bun.lock changed — running bun install...
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

## Flags

| Flag | Effect |
| --- | --- |
| `--dry` | Fetch `origin`, print the full plan, change nothing else |
| `-y, --yes` | Skip every confirmation prompt (deploys without a restart if `deploy.service` is unset) |
| `--force` | Run build + restart even when the pull brought no new commits |

---

## Errors

| Situation | Result |
| --- | --- |
| `deploy` config malformed (numeric `service`, empty `migrate`, …) | Exit 1 before anything is pulled |
| `cwd` is not a git work tree, or HEAD is detached | Exit 1 |
| Working tree has uncommitted changes | Exit 1 — commit or stash first |
| `deploy.service` / `deploy.migrate` unset in a non-interactive shell | Exit 1 naming the field and `--yes` |
| `git pull --ff-only` is not a fast-forward | Exit 1 — resolve the divergence manually |
| `bun install`, the migration, or `sudo systemctl restart` fails | Exit 1 at that step |
| `gyoza build` fails | Exit 1 — the service is **not** restarted, old process keeps serving |

---

## Notes

Runs against `process.cwd()`, like everything except `gyoza upgrade`.

A failed deploy is **not** rolled back — the pull stays applied. Re-run
`gyoza deploy` once the cause is fixed; the pull step is a no-op the second time
and the remaining steps proceed.
