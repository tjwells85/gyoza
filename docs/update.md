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

After `bun update` runs (and after catalog references are restored), gyoza
writes the pinned versions back to wherever they came from, undoing any bump
`bun update` made to them. Pass `--force` to skip this protection entirely
and let pinned packages update like any other.

---

## Catalog behavior

After updating, gyoza restores `catalog:` references in `frontend/package.json` and `server/package.json` (Bun workspace catalogs), then writes the updated resolved versions back to the `catalog` field in the root `package.json`. This keeps the catalog in sync with the actual installed versions.
