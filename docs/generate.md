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

### Safety behavior

- Before overwriting any existing `.env`, gyoza writes `.env.backup` alongside it.
- After writing, the generated file is validated: each expected key must appear, and no active `KEY=value` line may contain a raw Zod schema expression.
- If validation fails, the backup is restored and an error is thrown. The original file is never permanently lost.
