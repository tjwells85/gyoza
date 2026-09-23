# gyoza generate

Code generation commands.

---

## `gyoza generate env`

Generates `server/.env` and `frontend/.env` from their respective schema source files. Existing values are preserved. A `.env.backup` is written before any existing file is overwritten, and the original is restored if validation fails.

```bash
gyoza generate env
```

### Sources

| File                    | Parsed as                            |
| ----------------------- | ------------------------------------ |
| `server/env.ts`         | Zod `z.object({...})` schema         |
| `frontend/src/env.d.ts` | TypeScript `interface ImportMetaEnv` |

### Directives

Add directives as `//` comments immediately above a field in `server/env.ts` to control how the value is generated:

| Directive                  | Generated value                                    |
| -------------------------- | -------------------------------------------------- |
| `@generate base64:N`       | Random base64 string of N characters               |
| `@generate uuid`           | UUID v4                                            |
| `@generate alphanumeric:N` | Random alphanumeric string of N characters         |
| `@pgurl`                   | `postgresql://user:password@127.0.0.1:5432/dbname` |
| `@mongourl`                | `mongodb://user:password@127.0.0.1:27017/dbname`   |
| `@mysqlurl`                | `mysql://user:password@127.0.0.1:3306/dbname`      |
| `@apiurl`                  | `https://api.example.com`                          |
| `@placeholder <value>`     | The literal text after `@placeholder`              |

**Example:**

```ts
// server/env.ts
export const env = z.object({
  // @generate uuid
  SESSION_SECRET: z.string(),

  // @pgurl
  DATABASE_URL: z.string(),

  // @placeholder https://myapp.example.com
  APP_URL: z.string(),
});
```

### Rendering rules — server `env.ts`

| Field has…            | Written as                                               |
| --------------------- | -------------------------------------------------------- |
| Existing `.env` value | `KEY=<existing>` (preserved — never overwritten)         |
| `@directive`          | `KEY=<generated>`                                        |
| `.default(value)`     | `# KEY=value` (commented out)                            |
| Nothing               | `KEY=` (empty — Zod will error at runtime if not filled) |

### Rendering rules — frontend `env.d.ts`

| Field has…                    | Written as               |
| ----------------------------- | ------------------------ |
| Existing `.env` value         | `KEY=<existing>`         |
| `@directive`                  | `KEY=<generated>`        |
| `?:` or `string \| undefined` | `# KEY=` (commented out) |
| Nothing                       | `KEY=` (empty)           |

### Build tool detection (Vite vs Rsbuild)

Both Vite and Rsbuild support the same `interface ImportMetaEnv` / `interface ImportMeta` shape in
`frontend/src/env.d.ts`, so parsing and rendering are identical either way. Gyoza detects which tool
is in use by checking `frontend/` for a `vite.config.*` or `rsbuild.config.*` file, then checks
every field name against the tool's expected prefix — `VITE_` for Vite, `PUBLIC_` for Rsbuild's
default.

- A field using the *other* tool's prefix (e.g. `VITE_API_URL` when Rsbuild is detected) is an
  unambiguous swap. In an interactive terminal, gyoza lists the rename(s) and prompts
  `Rename to match rsbuild's "PUBLIC_" prefix? [Y/n]`. On confirmation it rewrites
  `frontend/src/env.d.ts` in place and carries forward the field's existing `.env` value under its
  new key. Declining, or running non-interactively (no TTY), leaves the field name untouched.
- A field matching neither prefix is only warned about — there's no unambiguous rename to offer.
- If a project overrides Rsbuild's default prefix via `loadEnv({ prefixes: [...] })`, gyoza still
  checks against `PUBLIC_` and may warn/prompt incorrectly — it doesn't parse `rsbuild.config.*` for
  a custom prefix.
- If neither config file is found, prefix checking is skipped entirely.

### Safety behavior

- Before overwriting any existing `.env`, gyoza writes `.env.backup` alongside it.
- After writing, the generated file is validated: each expected key must appear, and no active `KEY=value` line may contain a raw Zod schema expression.
- If validation fails, the backup is restored and an error is thrown. The original file is never permanently lost.
