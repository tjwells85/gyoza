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
