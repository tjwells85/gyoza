# gyoza update

Interactive dependency updater for Bun monorepos. Checks all workspaces for outdated packages, shows a report, and runs `bun update`.

```bash
gyoza update              # interactive, respects semver range
gyoza update --latest     # update to latest (ignores semver range)
gyoza update -y           # skip confirmation prompt
gyoza update --force      # also update packages pinned to an exact version
```

---

## Workspaces checked

Root, `frontend/`, `server/`, `shared/` — any workspace with a `package.json`.

---

## Outdated report

Runs `bun outdated` in each workspace and prints a consolidated report before prompting. Example output:

```text
root
┌─────────────────┬─────────┬────────┬────────┐
│ Package         │ Current │ Update │ Latest │
├─────────────────┼─────────┼────────┼────────┤
│ typescript-eslint│ 8.55.0  │ 8.59.2 │ 8.59.2 │
└─────────────────┴─────────┴────────┴────────┘

frontend
┌──────────────┬─────────┬────────┬────────┐
│ Package      │ Current │ Update │ Latest │
├──────────────┼─────────┼────────┼────────┤
│ vite         │ 6.0.1   │ 6.3.5  │ 6.3.5  │
└──────────────┴─────────┴────────┴────────┘

2 packages to update. Proceed? [Y/n]
```

Only packages with a genuine update are listed. Two things are filtered out:

- **Catalogued packages** — they appear in the separate catalog section below, not
  the per-workspace tables.
- **Age-gated packages** — `bun outdated` marks a version with `*` when a newer
  release exists but is blocked by `minimumReleaseAge`; the marked version is the
  newest one installable, so if it equals what you have there is nothing to do.

If no packages are outdated, the command exits immediately with no changes.

---

## Flags

| Flag               | Effect                                       |
| ------------------ | -------------------------------------------- |
| `--latest`         | Passes `--latest` to `bun update`, ignoring semver ranges and updating to the absolute latest version of each package |
| `-y` / `--yes`     | Skips the `[Y/n]` confirmation prompt        |
| `--force`          | Also updates packages pinned to an exact version (see below) |

---

## Pinned versions

A dependency pinned to an exact version — e.g. `"typescript": "6.0.3"` instead
of `"^6.0.3"` — anywhere in the root, `frontend/`, `server/`, or `shared/`
`package.json` (including the root `catalog`) is protected from `bun update`,
**even with `--latest`**. This is for packages with a known breaking release
you don't want to move off of automatically.

Before running any updates, gyoza scans for these exact-pinned versions and
prints a notice if a newer version exists:

```text
Pinned versions (protected — pass --force to update anyway):
──────────────────────────────
Package     Pinned   Latest
──────────────────────────────
typescript  6.0.3    7.0.2
```

In the per-workspace tables, a pinned package that has a newer version is shown
but tagged, and it is **not** counted toward "N updates available":

```text
Workspace: root
────────────────────────────────────────────────────────────
Package           Current    New Version
────────────────────────────────────────────────────────────
typescript (dev)  6.0.3      7.0.2  (pinned, not updated)
```

If every outstanding update is pinned, gyoza prints
`Nothing to update — N pinned package(s) have a newer version. Pass --force to
include them.` and exits.

After `bun update` runs (and after catalog references are restored), gyoza
writes the pinned versions back to wherever they came from, undoing any bump
`bun update` made to them. Pass `--force` to skip this protection entirely
and let pinned packages update like any other.

---

## Catalog behavior

Bun has no affordance for updating a workspace catalog — `bun update` cannot see
or rewrite the root `catalog` object, and there is no `bun catalog` command (the
same gap [`gyoza add`](catalog.md) fills). Left to bun, a catalogued dependency
like `"better-auth": "^1.6.25"` stays at that string forever, no matter how many
times you run `gyoza update --latest`.

So gyoza re-resolves each `catalog` entry itself, the same way the equivalent
standard dependency would move:

| Run | Each catalog entry moves to |
| --- | --- |
| `gyoza update` | newest published release still inside its current range (`^1.6.25` → `^1.7.2`, never crossing the major) |
| `gyoza update --latest` | absolute latest, caret-ranged (`^1.6.25` → `^2.3.0`) |

The catalog entries appear in their own section of the report and count toward
the confirmation prompt:

```text
Catalog (package.json)
────────────────────────────────────
Package      Current   New Version
────────────────────────────────────
better-auth  ^1.6.25   ^1.7.2
```

Details:

- **Exact-pinned catalog entries** (`"typescript": "6.0.3"`, and prerelease pins
  like `"react": "19.0.0-rc.1"` written by `gyoza add … @next`) are protected
  just like pinned workspace deps — skipped unless you pass `--force`.
- The **release-age gate** in `bunfig.toml` is honored: gyoza will not catalog a
  version `bun install` would then reject, dropping to the newest one old enough
  and saying so — identical to `gyoza add`.
- Existing catalog **order is preserved** — only the changed values are rewritten.
- If the registry can't be reached for one entry, gyoza warns and leaves that
  entry alone rather than aborting the whole update.

Separately, gyoza restores `catalog:` references in `frontend/package.json` and
`server/package.json` after `bun update` runs, in case a workspace was still
carrying a literal version from before it was catalogued.
