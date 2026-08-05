# gyoza upgrade

Updates gyoza itself. Nothing else in the project is touched.

```bash
gyoza upgrade
```

> `gyoza update` updates **your project's dependencies**.
> `gyoza upgrade` updates **gyoza**. They do not overlap.

---

## Why this exists

Gyoza is installed from git (`"gyoza": "github:tjwells85/gyoza"`), and a git
dependency with no version range behaves differently from a registry one:

- **`bun install` will not move it.** The lockfile pins a commit, the spec has no
  range to re-satisfy, so a stale entry stays stale indefinitely:

  ```text
  lock: gyoza@github:tjwells85/gyoza#35ad73c   (v0.4.1)
  spec: "gyoza": "github:tjwells85/gyoza"
  $ bun install  →  + gyoza@...#35ad73c   [13ms]   ← unchanged
  ```

- **`bun outdated` never lists it.** Git dependencies are absent from its output
  entirely, so gyoza can never appear in the `gyoza update` report no matter how
  far behind it is. Without this command there is no way to find out.

`bun update gyoza` *does* re-resolve to the remote's current commit. This command
wraps that, adds the reporting around it, and refuses to guess when it can't
actually do the job.

---

## What it does

1. Finds the `package.json` that declares gyoza — the root first, then each
   workspace. `bun update` runs from whichever directory owns the dependency.
2. Records the installed version from the gyoza package directory.
3. Runs `bun update gyoza`.
4. Reports the version change and, when moving forward, prints the changelog
   entries between the two versions.

```text
$ gyoza upgrade
Current: gyoza 0.4.1
Updating from github:tjwells85/gyoza...

installed gyoza@github:tjwells85/gyoza#61cd181 with binaries:
 - gyoza

  ✓  Updated gyoza 0.4.1 -> 0.5.0

Changes in this upgrade:

## [0.5.0] - 2026-07-23

### Fixed

- `gyoza update --latest` — packages pinned to an exact version ...

The new version applies to your next gyoza invocation.
```

The changelog section is why this is worth more than typing `bun update gyoza`:
it tells you immediately whether the upgrade changes behavior you should re-run.

---

## Specs with an explicit ref

If the spec carries a ref — `github:tjwells85/gyoza#main`, `#v0.5.0`, `#61cd181` —
the outcome depends on what kind of ref it is, and a branch cannot be told apart
from a tag without querying the remote. Rather than guess, gyoza says so and
reports what actually happened:

```text
Current: gyoza 0.5.0
  ⚠ The spec targets "v0.4.1" — a branch will move, a tag or commit will not.
```

A branch tracks and moves normally. A tag or commit does not, and you get:

```text
  ✓  Already up to date (gyoza 0.5.0).
     If "v0.4.1" is a tag or commit, bun update cannot move it — edit the spec in <dir>/package.json.
```

A pinned ref older than what's installed is a legitimate **downgrade**, and is
reported as one. The changelog is suppressed in that direction — an older
release's changelog cannot describe what changed since a newer one.

```text
  ✓  Downgraded gyoza 0.5.0 -> 0.4.1
     The spec targets "v0.4.1", which resolves to 0.4.1.
```

---

## Errors

| Situation | Message |
| --- | --- |
| No `package.json` in the project declares gyoza | Tells you to add it, and notes that `bunx gyoza` installs a throwaway copy with nothing to update |
| Running from a source checkout rather than `node_modules` | Names the directory it resolved to and stops |
| gyoza declared but not installed | Points at the unreadable package directory — run `bun install` |

All exit `1`.

---

## Notes

This is the one command that deliberately resolves paths against its **own
install location** instead of `process.cwd()` — it is updating itself, not the
project. Everything else in gyoza follows the `process.cwd()` rule.

Replacing gyoza's files while it is running is safe: Bun has already loaded the
entry point into memory, so the current invocation finishes on the old code and
the new version takes effect the next time you run it.
