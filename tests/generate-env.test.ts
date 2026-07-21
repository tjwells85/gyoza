import { describe, test, expect } from 'bun:test';
import {
  parseEnvTs,
  renderEnv,
  validateGeneratedEnv,
  parseEnvFile,
  parseFrontendEnvTs,
  correctFrontendEnvReadonly,
  generateValue,
} from '../src/commands/generate/env.ts';

// Sample server env.ts schema, deliberately pushing every documented directive,
// rendering rule, and edge case: multi-line Prettier-wrapped chains, section
// headers (single- and multi-line JSDoc), directive-vs-default precedence,
// and optional fields.
const SAMPLE_SERVER_ENV_TS = `
import * as z from 'zod';

export const ServerEnv = z.object({
  // Server port to listen on
  PORT: z.coerce.number().int().positive().default(3000),
  // Show available routes on startup
  SHOW_ROUTES: z.stringbool().default(false),
  // Development mode flag
  DEV_MODE: z.stringbool().default(false),
  // FRONTEND_URL
  ORIGIN: z.url().default('http://localhost:5000'),
  /** Database */
  // @pgurl
  POSTGRES_URL: z.url().refine((val) => val.startsWith('postgres://') || val.startsWith('postgresql://'), { error: 'Not a valid PostgreSQL URL' }),
  // @mongourl
  MONGO_URL: z.url(),
  // @mysqlurl
  MYSQL_URL: z.url(),
  /** Authentication */
  // Backend URL
  BETTER_AUTH_URL: z.url().default('http://localhost:3000'),
  // @generate base64:32
  BETTER_AUTH_SECRET: z.string().trim(),
  // @generate uuid
  SESSION_ID: z.string().trim(),
  // @generate alphanumeric:24
  API_KEY: z.string().trim(),
  // @apiurl
  UPSTREAM_API_URL: z.url(),
  // @placeholder replace-me-manually
  MANUAL_SECRET: z.string().trim(),
  // Directive should win over an existing .default(...) on the same field
  // @placeholder directive-wins
  DIRECTIVE_BEATS_DEFAULT: z.string().default('should-not-appear'),
  ENTRA_TENANT_ID: z.string().trim(),
  ENTRA_CLIENT_ID: z.string().trim(),
  ENTRA_CLIENT_SECRET: z.string().trim(),
  /**
   * Encryption
   * Multi-line JSDoc section header (not just single-line)
   */
  // @generate base64:32
  // AES-256-GCM key: base64 string decoding to exactly 32 bytes
  ENCRYPTION_KEY: z
    .string()
    .trim()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      error: 'ENCRYPTION_KEY must be base64 that decodes to exactly 32 bytes',
    }),
  /** Email Notifications */
  SMTP_HOST: z.string().trim(),
  SMTP_PORT: z.coerce.number().int().positive().default(25),
  SMTP_USER: z.string().trim().optional(),
  SMTP_PASS: z.string().trim().optional(),
  SMTP_FROM: z.email().trim(),
});
export type ServerEnv = z.infer<typeof ServerEnv>;

export const ProcessEnv = ServerEnv.parse(process.env);
`;

const ALL_FIELD_NAMES = [
  'PORT',
  'SHOW_ROUTES',
  'DEV_MODE',
  'ORIGIN',
  'POSTGRES_URL',
  'MONGO_URL',
  'MYSQL_URL',
  'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET',
  'SESSION_ID',
  'API_KEY',
  'UPSTREAM_API_URL',
  'MANUAL_SECRET',
  'DIRECTIVE_BEATS_DEFAULT',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
];

describe('parseEnvTs', () => {
  const fields = parseEnvTs(SAMPLE_SERVER_ENV_TS);
  const fieldNames = fields.filter((f) => f.kind === 'field').map((f) => f.name);

  test('finds every field, including multi-line Prettier-wrapped chains', () => {
    expect(fieldNames).toEqual(ALL_FIELD_NAMES);
  });

  test('parses a multi-line chain field (ENCRYPTION_KEY) with its directive and comment', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'ENCRYPTION_KEY');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.directives).toEqual(['@generate base64:32']);
    expect(field.comments).toEqual(['AES-256-GCM key: base64 string decoding to exactly 32 bytes']);
    expect(field.defaultValue).toBeUndefined();
  });

  test('parses a single-line field with a directive (POSTGRES_URL)', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'POSTGRES_URL');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.directives).toEqual(['@pgurl']);
  });

  test('extracts .default(...) values across types (number, boolean, string)', () => {
    const port = fields.find((f) => f.kind === 'field' && f.name === 'PORT');
    if (port?.kind !== 'field') throw new Error('expected field');
    expect(port.defaultValue).toBe('3000');

    const showRoutes = fields.find((f) => f.kind === 'field' && f.name === 'SHOW_ROUTES');
    if (showRoutes?.kind !== 'field') throw new Error('expected field');
    expect(showRoutes.defaultValue).toBe('false');

    const origin = fields.find((f) => f.kind === 'field' && f.name === 'ORIGIN');
    if (origin?.kind !== 'field') throw new Error('expected field');
    expect(origin.defaultValue).toBe('http://localhost:5000');
  });

  test('captures both a directive and a default on the same field', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'DIRECTIVE_BEATS_DEFAULT');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.directives).toEqual(['@placeholder directive-wins']);
    expect(field.defaultValue).toBe('should-not-appear');
  });

  test('parses single-line JSDoc section headers without swallowing following fields', () => {
    const sectionIdx = fields.findIndex((f) => f.kind === 'section' && f.lines.some((l) => l.includes('Database')));
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(fields[sectionIdx + 1]?.kind).toBe('field');
  });

  test('parses multi-line JSDoc section headers', () => {
    const section = fields.find((f) => f.kind === 'section' && f.lines.some((l) => l.includes('Encryption')));
    expect(section).toBeDefined();
    if (section?.kind !== 'section') throw new Error('expected section');
    expect(section.lines.length).toBeGreaterThan(1);
  });

  test('server fields never get `optional` set (no such column in the spec)', () => {
    const smtpUser = fields.find((f) => f.kind === 'field' && f.name === 'SMTP_USER');
    if (smtpUser?.kind !== 'field') throw new Error('expected field');
    expect(smtpUser.optional).toBeUndefined();
  });
});

describe('generateValue', () => {
  test('@generate uuid produces a v4 UUID', () => {
    const v = generateValue('@generate uuid');
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('@generate alphanumeric:N produces exactly N alphanumeric chars', () => {
    const v = generateValue('@generate alphanumeric:24');
    expect(v).toHaveLength(24);
    expect(v).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  test('@generate base64:N produces a string of exactly N characters', () => {
    const v = generateValue('@generate base64:32');
    expect(v).toHaveLength(32);
  });

  test('@generate base64:N is a character-length directive, not a decoded-byte-length one', () => {
    // Worth knowing: `@generate base64:32` yields a 32-CHARACTER base64 string,
    // which decodes to only 24 bytes -- not 32. A field whose zod .refine()
    // requires exactly 32 decoded bytes (e.g. an AES-256 key, as in the
    // ENCRYPTION_KEY sample above) needs a larger N, not `base64:32`.
    const v = generateValue('@generate base64:32');
    expect(v).toHaveLength(32);
    expect(Buffer.from(v, 'base64').length).toBe(24);
  });

  test('@pgurl / @mongourl / @mysqlurl / @apiurl produce their fixed placeholder URLs', () => {
    expect(generateValue('@pgurl')).toBe('postgresql://user:password@127.0.0.1:5432/dbname');
    expect(generateValue('@mongourl')).toBe('mongodb://user:password@127.0.0.1:27017/dbname');
    expect(generateValue('@mysqlurl')).toBe('mysql://user:password@127.0.0.1:3306/dbname');
    expect(generateValue('@apiurl')).toBe('https://api.example.com');
  });

  test('@placeholder <value> returns the literal text after the directive', () => {
    expect(generateValue('@placeholder hello world')).toBe('hello world');
  });
});

describe('renderEnv', () => {
  const fields = parseEnvTs(SAMPLE_SERVER_ENV_TS);
  const output = renderEnv(fields, {});

  test('emits every field key somewhere in the output', () => {
    for (const name of ALL_FIELD_NAMES) {
      expect(output).toMatch(new RegExp(`^#?\\s*${name}=`, 'm'));
    }
  });

  test('generates a value for a multi-line chain field (ENCRYPTION_KEY) from its directive', () => {
    const match = output.match(/^ENCRYPTION_KEY=(.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1].length).toBeGreaterThan(0);
  });

  test('directive precedence: @pgurl / @mongourl / @mysqlurl / @apiurl all render uncommented', () => {
    expect(output).toContain('POSTGRES_URL=postgresql://user:password@127.0.0.1:5432/dbname');
    expect(output).toContain('MONGO_URL=mongodb://user:password@127.0.0.1:27017/dbname');
    expect(output).toContain('MYSQL_URL=mysql://user:password@127.0.0.1:3306/dbname');
    expect(output).toContain('UPSTREAM_API_URL=https://api.example.com');
  });

  test('@placeholder renders its literal value', () => {
    expect(output).toContain('MANUAL_SECRET=replace-me-manually');
  });

  test('a directive on a field beats that field\'s .default(...)', () => {
    expect(output).toContain('DIRECTIVE_BEATS_DEFAULT=directive-wins');
    expect(output).not.toContain('should-not-appear');
  });

  test('comments out fields with a .default(...) and no existing value or directive', () => {
    expect(output).toContain('# PORT=3000');
    expect(output).toContain('# SMTP_PORT=25');
    expect(output).toContain('# SHOW_ROUTES=false');
  });

  test('leaves fields with no directive/default as empty (not commented, not missing)', () => {
    expect(output).toMatch(/^ENTRA_TENANT_ID=$/m);
    expect(output).toMatch(/^SMTP_HOST=$/m);
  });

  test('server-side .optional() fields with no directive/default render as plain empty, same as required fields', () => {
    expect(output).toMatch(/^SMTP_USER=$/m);
    expect(output).toMatch(/^SMTP_PASS=$/m);
    expect(output).not.toMatch(/^# SMTP_USER=/m);
  });

  test('preserves an existing .env value over a directive AND a default', () => {
    const withExisting = renderEnv(fields, {
      ENCRYPTION_KEY: 'existing-value-from-dotenv',
      PORT: '9999',
    });
    expect(withExisting).toContain('ENCRYPTION_KEY=existing-value-from-dotenv');
    expect(withExisting).toContain('PORT=9999');
    expect(withExisting).not.toMatch(/^# PORT=/m);
  });
});

describe('parseEnvFile', () => {
  test('parses KEY=VALUE lines, ignoring blanks, comments, and malformed lines', () => {
    const path = `/tmp/gyoza-test-envfile-${Date.now()}.env`;
    Bun.write(
      path,
      [
        '# a comment', //
        '',
        'FOO=bar',
        'MULTI=a=b=c', // value itself contains '='
        'NOVALUE',
        'BAZ=',
      ].join('\n'),
    );
    const parsed = parseEnvFile(path);
    expect(parsed).toEqual({ FOO: 'bar', MULTI: 'a=b=c', BAZ: '' });
  });

  test('returns {} for a nonexistent path', () => {
    expect(parseEnvFile('/tmp/does-not-exist-gyoza.env')).toEqual({});
  });
});

describe('validateGeneratedEnv', () => {
  test('flags a key that is genuinely absent', () => {
    const fields = [{ kind: 'field' as const, name: 'MISSING_KEY', directives: [], comments: [] }];
    const errors = validateGeneratedEnv(fields, 'OTHER_KEY=value\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('MISSING_KEY');
  });

  test('does not false-positive when one key name is a suffix of another (e.g. URL vs POSTGRES_URL)', () => {
    const fields = [{ kind: 'field' as const, name: 'URL', directives: [], comments: [] }];
    // URL= is genuinely missing here; only POSTGRES_URL= is present.
    const errors = validateGeneratedEnv(fields, 'POSTGRES_URL=postgresql://user:password@127.0.0.1:5432/dbname\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"URL"');
  });

  test('accepts the key when present, commented or not', () => {
    const fields = [{ kind: 'field' as const, name: 'URL', directives: [], comments: [] }];
    expect(validateGeneratedEnv(fields, 'URL=http://example.com\n')).toEqual([]);
    expect(validateGeneratedEnv(fields, '# URL=\n')).toEqual([]);
  });

  test('flags leaked zod schema code in an active value', () => {
    const fields = [{ kind: 'field' as const, name: 'SMTP_FROM', directives: [], comments: [] }];
    const errors = validateGeneratedEnv(fields, 'SMTP_FROM=z.email().trim()\n');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('leaked');
  });

  test('known gap: a leaked z.coerce.number(...) chain is NOT caught by the documented pattern', () => {
    // The zodPattern regex (per CLAUDE.md) is `z\.(string|coerce|boolean|number|preprocess|email|url|ipv4)\(`.
    // It requires the alternative immediately after "z.". Real `z.coerce.*` usage
    // is always `z.coerce.number(...)` / `z.coerce.string(...)` etc, where "coerce"
    // is followed by "." not "(", so the "coerce" alternative can never actually
    // match, and "number(" isn't preceded directly by "z." either. This is a
    // documented-spec limitation, not something to silently change.
    const fields = [{ kind: 'field' as const, name: 'PORT', directives: [], comments: [] }];
    const errors = validateGeneratedEnv(fields, 'PORT=z.coerce.number().int().positive().default(3000)\n');
    expect(errors).toEqual([]);
  });

  test('does not flag zod-looking text inside a commented-out line', () => {
    const fields = [{ kind: 'field' as const, name: 'PORT', directives: [], comments: [] }];
    const errors = validateGeneratedEnv(fields, '# PORT=z.coerce.number()\n');
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Frontend (frontend/src/env.d.ts) parsing
// ---------------------------------------------------------------------------

const SAMPLE_FRONTEND_ENV_TS = `
interface ImportMetaEnv {
  /** API Configuration */
  // @apiurl
  readonly VITE_API_URL: string;
  // @generate uuid
  VITE_SESSION_ID: string;
  // optional via '?:' syntax, not yet marked readonly
  VITE_APP_NAME?: string;
  // optional via '| undefined' syntax
  VITE_DEBUG: string | undefined;
  // optional AND has a directive -- directive should still win
  // @placeholder some-flag-value
  VITE_FEATURE_FLAG?: string;

  readonly VITE_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
`;

describe('correctFrontendEnvReadonly', () => {
  test('adds readonly to fields missing it, leaves already-readonly fields alone', () => {
    const corrected = correctFrontendEnvReadonly(SAMPLE_FRONTEND_ENV_TS);
    expect(corrected).toContain('readonly VITE_SESSION_ID: string;');
    expect(corrected).toContain('readonly VITE_APP_NAME?: string;');
    expect(corrected).toContain('readonly VITE_DEBUG: string | undefined;');
    expect(corrected).toContain('readonly VITE_FEATURE_FLAG?: string;');
    // Already-readonly fields aren't doubled up.
    expect(corrected).not.toContain('readonly readonly');
    expect((corrected.match(/readonly VITE_API_URL/g) || []).length).toBe(1);
  });

  test('is a no-op outside the ImportMetaEnv interface (ImportMeta.env stays untouched)', () => {
    const corrected = correctFrontendEnvReadonly(SAMPLE_FRONTEND_ENV_TS);
    expect(corrected).toContain('readonly env: ImportMetaEnv;');
  });
});

describe('parseFrontendEnvTs', () => {
  const corrected = correctFrontendEnvReadonly(SAMPLE_FRONTEND_ENV_TS);
  const fields = parseFrontendEnvTs(corrected);
  const fieldNames = fields.filter((f) => f.kind === 'field').map((f) => f.name);

  test('finds every field in the interface', () => {
    expect(fieldNames).toEqual(['VITE_API_URL', 'VITE_SESSION_ID', 'VITE_APP_NAME', 'VITE_DEBUG', 'VITE_FEATURE_FLAG', 'VITE_VERSION']);
  });

  test('detects optional via "?:" syntax', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'VITE_APP_NAME');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.optional).toBe(true);
  });

  test('detects optional via "| undefined" syntax', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'VITE_DEBUG');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.optional).toBe(true);
  });

  test('required fields are not marked optional', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'VITE_VERSION');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.optional).toBeFalsy();
  });

  test('parses directives and comments the same way as the server parser', () => {
    const field = fields.find((f) => f.kind === 'field' && f.name === 'VITE_SESSION_ID');
    if (field?.kind !== 'field') throw new Error('expected field');
    expect(field.directives).toEqual(['@generate uuid']);
  });

  test('single-line JSDoc section header does not swallow the following field', () => {
    const sectionIdx = fields.findIndex((f) => f.kind === 'section');
    expect(sectionIdx).toBeGreaterThan(-1);
    expect(fields[sectionIdx + 1]?.kind).toBe('field');
  });
});

describe('renderEnv (frontend fields)', () => {
  const corrected = correctFrontendEnvReadonly(SAMPLE_FRONTEND_ENV_TS);
  const fields = parseFrontendEnvTs(corrected);
  const output = renderEnv(fields, {});

  test('optional field with no directive/existing value is commented out', () => {
    expect(output).toMatch(/^# VITE_DEBUG=$/m);
  });

  test('optional field WITH a directive still renders uncommented (directive beats optional)', () => {
    expect(output).toContain('VITE_FEATURE_FLAG=some-flag-value');
    expect(output).not.toMatch(/^# VITE_FEATURE_FLAG=/m);
  });

  test('required field with no directive/default renders as plain empty', () => {
    expect(output).toMatch(/^VITE_VERSION=$/m);
  });

  test('directive fields render their generated/placeholder value', () => {
    expect(output).toContain('VITE_API_URL=https://api.example.com');
    expect(output).toMatch(/^VITE_SESSION_ID=[0-9a-f-]{36}$/m);
  });
});
