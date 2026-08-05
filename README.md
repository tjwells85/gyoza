# gyoza

CLI tooling for projects scaffolded from [`hono-react-template`](https://github.com/tjwells85/hono-react-template) — a fullstack Bun + Hono + React monorepo. Gyoza extracts the maintenance scripts into a versioned package so all downstream projects receive bug fixes and improvements via `bun update`.

> The name: Hono means "flame", Bun's mascot is a bao, gyoza are pan-fried dumplings — fire + bao.

---

## Installation

Add gyoza as a dev dependency in your project root `package.json`:

```json
"devDependencies": {
  "gyoza": "github:tjwells85/gyoza"
}
```

Run `bun install`, then run `gyoza init scripts` to add the standard scripts to your `package.json` automatically:

```bash
bunx gyoza init scripts
```

Or add them manually:

```json
"scripts": {
  "generate:env":  "gyoza generate env",
  "update:all":    "gyoza update",
  "update:latest": "gyoza update --latest",
  "build":         "gyoza build"
}
```

---

## Commands

| Command              | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `gyoza init <cmd>`   | Project initialization and migration tools           |
| `gyoza generate env` | Generate `.env` files from schema sources            |
| `gyoza add`          | `bun add` with workspace catalog support             |
| `gyoza remove`       | `bun remove` with workspace catalog support          |
| `gyoza update`       | Interactive updater for your project dependencies    |
| `gyoza upgrade`      | Update gyoza itself from its git remote              |
| `gyoza build`        | Production build pipeline                            |
| `gyoza help`         | Print available commands at any level                |

---

## Documentation

- [init commands](docs/init.md) — `init scripts`, `init eslint`, `init config`
- [generate commands](docs/generate.md) — `generate env`
- [add / remove](docs/catalog.md) — bun wrappers with workspace catalog support
- [update](docs/update.md) — dependency update workflow
- [upgrade](docs/upgrade.md) — updating gyoza itself
- [build](docs/build.md) — production build pipeline
- [gyoza.config.ts reference](docs/config.md) — build config, custom scripts
- [Developing new commands](docs/development.md) — public API, architecture, contributor guide

---

## Help

```bash
gyoza help                           # all top-level commands
gyoza <namespace> --help             # e.g. gyoza init --help
gyoza <namespace> <command> --help   # e.g. gyoza generate env --help
```
