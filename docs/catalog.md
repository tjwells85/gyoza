# gyoza add / gyoza remove

Wrappers around `bun add` and `bun remove` that add catalog support.

Bun has no CLI affordance for writing to a workspace catalog — `bun add` has no
`--catalog` flag and there is no `bun catalog` command. Adding a catalogued
dependency by hand means looking up the current version, typing it into the root
`catalog` object, then adding `"pkg": "catalog:"` to each workspace. These commands
do all three in one step.

```bash
gyoza add --catalog server,frontend,shared date-fns
gyoza add --catalog frontend react@next
gyoza add --catalog shared date-fns          # extend an existing entry
gyoza remove --catalog shared date-fns
```

Without `--catalog`, both commands are pure passthroughs — `gyoza add date-fns` is
exactly `bun add date-fns`, arguments and all.

---

## Flags

Everything below applies to catalog mode only.

| Flag | Effect |
| --- | --- |
| `--catalog <ws,...>` | Target workspaces, comma-separated. `--catalog=a,b` also works. Presence of this flag is what switches on catalog mode. |
| `--dry` | Print the plan, touch nothing |
| `-y`, `--yes` | Skip confirmation prompts |
| `-E`, `--exact` | Write the resolved version without a `^` range (`add` only) |
| `-d`, `-D`, `--dev` | Put `"pkg": "catalog:"` in `devDependencies` (`add` only) |
| `--peer` | Put it in `peerDependencies` (`add` only) |
| `--optional` | Put it in `optionalDependencies` (`add` only) |

Bun flags that gyoza cannot honor in catalog mode — `-a`/`--analyze` and
`--only-missing` — are rejected with an error rather than silently dropped. In
catalog mode gyoza writes `package.json` directly and then runs a single
`bun install`; it never invokes `bun add`, so there is nothing to pass them to.

Workspace names are validated against the root `workspaces` array. A typo errors
out and lists the valid names. `root` is not a workspace, so it is not a valid
target.

> `gyoza add --help` prints gyoza's help, never bun's — the CLI intercepts `--help`
> before dispatching. Run `bun add --help` for bun's own flag list.

---

## Version resolution

`bun info` does the resolving. What lands in the root catalog:

| Spec | Catalog value |
| --- | --- |
| `date-fns` | `^4.4.0` — resolved, caret-ranged |
| `date-fns@latest` | `^4.4.0` |
| `date-fns@next` | `5.0.0-alpha.0` — resolved, pinned exactly |
| `date-fns@^3.0.4` | `^3.0.4` — verbatim |
| `date-fns@3.6.0` | `3.6.0` — verbatim |
| `-E date-fns` | `4.4.0` |

Explicit versions and ranges are stored **verbatim**, matching what
`bun add date-fns@^3.0.4` writes into a `package.json`. Only bare names and
dist-tags get resolved.

**Prereleases are always pinned exactly**, never caret-ranged. `^5.0.0-alpha.0`
means `>=5.0.0-alpha.0 <6.0.0`, which would happily match a stable `5.0.0` — not
what asking for `@next` means. As a side effect these entries are also protected
from [`gyoza update`](update.md#pinned-versions) unless you pass `--force`.

An unknown dist-tag is an error. This matters because `bun info pkg@bogustag`
silently falls back to `latest`, so gyoza validates the tag against
`bun info pkg dist-tags` before trusting the resolved version.

---

## `gyoza add`

New catalog entries are **appended** to the end of the `catalog` object. The
existing order is never re-sorted — a sort would turn the first run into one large
unreadable diff.

### Extending an existing entry

If a package is already in the catalog and you don't give a version, gyoza reuses
the catalog version as-is and only wires up the new workspaces:

```bash
# catalog already has "date-fns": "^4.4.0", used by server and frontend
gyoza add --catalog shared date-fns
```

```text
Catalog (package.json):
  "date-fns": "^4.4.0" (unchanged)

Workspaces:
  shared/package.json  "date-fns": (none) -> "catalog:" (dependencies)
```

No registry lookup happens, and `server` / `frontend` are untouched. This is the
common case and it can never bump a version out from under another workspace.

### Version clashes

Giving an explicit version that differs from the current catalog entry is the only
way to change a version other workspaces already depend on, so it prompts and
**defaults to no**:

```text
"date-fns" is already in the catalog at ^4.4.0.
Changing it to ^3.0.4 affects: server, frontend, shared
Update the catalog entry? [y/N]
```

Declining skips that package entirely — neither the catalog nor any workspace is
touched. `-y` accepts without asking.

### Sections

A package is removed from every other dependency section before the `catalog:`
reference is written, so `gyoza add --catalog server -d date-fns` on a workspace
that already has `date-fns` in `dependencies` moves it rather than duplicating it.

---

## `gyoza remove`

Removes the package from the targeted workspaces, from whichever dependency
section declares it. Then it checks whether any workspace still references the
package via `catalog:`. If none do, the catalog entry is orphaned and gyoza offers
to prune it — this one **defaults to yes**:

```text
No workspace references "date-fns" (^4.4.0) anymore.
Remove it from the root catalog? [Y/n]
```

Answer `n` to park the entry for later reuse. `-y` prunes without asking. A version
suffix on the argument (`date-fns@^4.4.0`) is ignored — only the name matters.

---

## Catalog shape

Gyoza reads and writes Bun's top-level `catalog` field:

```json
{
  "workspaces": ["server", "frontend", "shared"],
  "catalog": {
    "hono": "^4.12.29",
    "date-fns": "^4.4.0"
  }
}
```

Named catalogs (`catalogs: { testing: {...} }`, referenced as `catalog:testing`)
are not supported.
