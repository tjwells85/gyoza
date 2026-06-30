# gyoza update

Interactive dependency updater for Bun monorepos. Checks all workspaces for outdated packages, shows a report, and runs `bun update`.

```bash
gyoza update              # interactive, respects semver range
gyoza update --latest     # update to latest (ignores semver range)
gyoza update -y           # skip confirmation prompt
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

---

## Catalog behavior

After updating, gyoza restores `catalog:` references in `frontend/package.json` and `server/package.json` (Bun workspace catalogs), then writes the updated resolved versions back to the `catalog` field in the root `package.json`. This keeps the catalog in sync with the actual installed versions.
