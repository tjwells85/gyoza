# gyoza build

Builds the monorepo for production.

```bash
gyoza build
```

---

## Build phases

Runs in order:

| Phase          | What happens                                                               |
| -------------- | -------------------------------------------------------------------------- |
| **Clean install** | (optional) Removes all `node_modules` recursively, then runs `bun install` |
| **Clean**      | Removes and recreates the `build/` directory                               |
| **Pre steps**  | Any custom steps defined in `gyoza.config.ts` → `build.pre`               |
| **Build**      | Compiles the frontend (`bun run --filter=frontend build`) and bundles the server (`Bun.build` targeting `bun`) |
| **Assemble**   | Copies `frontend/dist` → `build/client` and `server/.env` → `build/.env`  |
| **Post steps** | Any custom steps defined in `gyoza.config.ts` → `build.post`              |

The build config is validated before any of this runs, so a malformed step never leaves a half-built `build/` behind.

Whatever a step returns is passed to later steps as `ctx.results`, so a `post` step can act on what a `pre` step found — copying an artifact only when the `pre` step reports it actually changed, for instance. See [step results](config.md#step-results).

---

## Pre-build checks

Before cleaning the build directory, gyoza can run `tsc --noEmit` and `eslint .` in parallel. If either check finds issues, the build is aborted before any files are changed — the existing `build/` is left intact.

Configure via `gyoza.config.ts`:

```ts
export default {
  build: {
    typecheck: 'fail',  // 'off' | 'warn' | 'fail'
    lint: 'fail',       // 'off' | 'warn' | 'fail' | { onError, onWarning }
  },
} satisfies GyozaConfig;
```

Both default to `'off'`. See the [gyoza.config.ts reference](config.md) for the full `build` config shape including custom pre/post steps.

---

## Output structure

```text
build/
├── client/       ← frontend/dist contents
├── .env          ← copied from server/.env
└── server        ← Bun-bundled server entry
```
