import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const PROJECT_ROOT = process.cwd();
const SERVER_ENV_TS = join(PROJECT_ROOT, 'server/env.ts');
const SERVER_ENV = join(PROJECT_ROOT, 'server/.env');
const FRONTEND_ENV_TS = join(PROJECT_ROOT, 'frontend/src/env.d.ts');
const FRONTEND_ENV = join(PROJECT_ROOT, 'frontend/.env');

type EnvField =
  | {
      kind: 'field';
      name: string;
      defaultValue?: string;
      optional?: boolean;
      directives: string[];
      comments: string[];
    }
  | { kind: 'section'; lines: string[] }
  | { kind: 'blank' };

const generateBase64 = (length: number): string => {
  const bytes = Math.ceil((length * 3) / 4);
  return randomBytes(bytes).toString('base64').slice(0, length);
};

const generateAlphanumeric = (length: number): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
};

export const generateValue = (directive: string): string => {
  if (directive.startsWith('@generate base64:')) {
    const length = parseInt(directive.split(':')[1], 10);
    return generateBase64(length);
  }

  if (directive === '@generate uuid') {
    return randomUUID();
  }

  if (directive.startsWith('@generate alphanumeric:')) {
    const length = parseInt(directive.split(':')[1], 10);
    return generateAlphanumeric(length);
  }

  if (directive === '@pgurl') return 'postgresql://user:password@127.0.0.1:5432/dbname';
  if (directive === '@mongourl') return 'mongodb://user:password@127.0.0.1:27017/dbname';
  if (directive === '@mysqlurl') return 'mysql://user:password@127.0.0.1:3306/dbname';
  if (directive === '@apiurl') return 'https://api.example.com';

  if (directive.startsWith('@placeholder ')) {
    return directive.slice('@placeholder '.length);
  }

  return '';
};

const extractDefault = (fieldLine: string): string | undefined => {
  const match = fieldLine.match(/\.default\((['"`]?)([^)]+)\1\)/);
  return match ? match[2] : undefined;
};

export const parseEnvTs = (src: string): EnvField[] => {
  const lines = src.split('\n');
  const fields: EnvField[] = [];

  let objectStart = -1;
  let objectEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('z.object({')) {
      objectStart = i;
      let braceDepth = 1;

      for (let j = i + 1; j < lines.length; j++) {
        const openCount = (lines[j].match(/{/g) || []).length;
        const closeCount = (lines[j].match(/}/g) || []).length;
        braceDepth += openCount - closeCount;

        if (braceDepth === 0) {
          objectEnd = j;
          break;
        }
      }

      break;
    }
  }

  if (objectStart === -1 || objectEnd === -1) return fields;

  const objectLines = lines.slice(objectStart + 1, objectEnd);
  const commentBuffer: string[] = [];
  const directiveBuffer: string[] = [];
  let i = 0;

  while (i < objectLines.length) {
    const line = objectLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('/**')) {
      const blockLines: string[] = [trimmed];

      if (!trimmed.includes('*/')) {
        i++;
        while (i < objectLines.length) {
          blockLines.push(objectLines[i].trim());
          if (objectLines[i].trim().includes('*/')) break;
          i++;
        }
      }

      fields.push({ kind: 'section', lines: blockLines });
      commentBuffer.length = 0;
      directiveBuffer.length = 0;
      i++;
      continue;
    }

    if (trimmed.startsWith('//')) {
      const commentText = trimmed.slice(2).trim();
      if (commentText.startsWith('@')) {
        directiveBuffer.push(commentText);
      } else {
        commentBuffer.push(commentText);
      }
      i++;
      continue;
    }

    if (!trimmed) {
      fields.push({ kind: 'blank' });
      commentBuffer.length = 0;
      directiveBuffer.length = 0;
      i++;
      continue;
    }

    if (trimmed.match(/^\w+:\s*z\b/)) {
      const fieldName = trimmed.split(':')[0];
      const fieldLines: string[] = [line];

      const depthDelta = (s: string): number => (s.match(/[({]/g) || []).length - (s.match(/[)}]/g) || []).length;

      let depth = depthDelta(line);
      let complete = depth === 0 && /,\s*$/.test(trimmed);

      // Prettier can wrap long chains onto multiple lines (e.g. `KEY: z\n  .string()...`).
      // Keep consuming lines until the bracket depth returns to zero at a trailing comma,
      // so multi-line field definitions aren't dropped or truncated.
      while (!complete && i + 1 < objectLines.length) {
        i++;
        const nextLine = objectLines[i];
        fieldLines.push(nextLine);
        depth += depthDelta(nextLine);
        complete = depth === 0 && /,\s*$/.test(nextLine.trim());
      }

      const defaultValue = extractDefault(fieldLines.join('\n'));

      fields.push({
        kind: 'field',
        name: fieldName,
        defaultValue,
        directives: [...directiveBuffer],
        comments: [...commentBuffer],
      });

      commentBuffer.length = 0;
      directiveBuffer.length = 0;
    }

    i++;
  }

  return fields;
};

export const parseEnvFile = (path: string): Record<string, string> => {
  if (!existsSync(path)) return {};

  const content = readFileSync(path, 'utf-8');
  const env: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }

  return env;
};

export const renderEnv = (fields: EnvField[], existing: Record<string, string>): string => {
  const lines: string[] = [];

  for (const field of fields) {
    if (field.kind === 'section') {
      lines.push('');
      lines.push('###############################################');
      for (const line of field.lines) {
        const cleanLine = line.replace(/^\/\*\*/, '').replace(/\*\/$/, '').trim();
        if (cleanLine && cleanLine !== '*') {
          lines.push(`# ${cleanLine.replace(/^\*\s*/, '')}`);
        }
      }
      lines.push('###############################################');
      lines.push('');
    } else if (field.kind === 'blank') {
      lines.push('');
    } else if (field.kind === 'field') {
      for (const comment of field.comments) {
        lines.push(`# ${comment}`);
      }

      if (existing[field.name] !== undefined) {
        lines.push(`${field.name}=${existing[field.name]}`);
      } else if (field.directives.length > 0) {
        lines.push(`${field.name}=${generateValue(field.directives[0])}`);
      } else if (field.defaultValue !== undefined) {
        lines.push(`# ${field.name}=${field.defaultValue}`);
      } else if (field.optional) {
        lines.push(`# ${field.name}=`);
      } else {
        lines.push(`${field.name}=`);
      }
    }
  }

  return lines.join('\n').trim() + '\n';
};

export const validateGeneratedEnv = (fields: EnvField[], content: string): string[] => {
  const errors: string[] = [];
  const zodPattern = /z\.(string|coerce|boolean|number|preprocess|email|url|ipv4)\(/;

  for (const field of fields) {
    if (field.kind !== 'field') continue;

    if (!new RegExp(`^#?\\s*${field.name}=`, 'm').test(content)) {
      errors.push(`Key "${field.name}" is missing from generated output`);
      continue;
    }

    const activeMatch = content.match(new RegExp(`^${field.name}=(.+)$`, 'm'));
    if (activeMatch?.[1] && zodPattern.test(activeMatch[1])) {
      errors.push(`Zod schema code leaked into value for "${field.name}": ${activeMatch[1]}`);
    }
  }

  return errors;
};

const writeEnvSafe = (envPath: string, backupPath: string, content: string, fields: EnvField[]): void => {
  const hadExisting = existsSync(envPath);

  if (hadExisting) {
    copyFileSync(envPath, backupPath);
  }

  writeFileSync(envPath, content);

  const errors = validateGeneratedEnv(fields, content);

  if (errors.length > 0) {
    if (hadExisting) {
      copyFileSync(backupPath, envPath);
      console.error('  ✗ Validation failed — reverted to backup');
    } else {
      console.error('  ✗ Validation failed');
    }
    for (const err of errors) {
      console.error(`    - ${err}`);
    }
    throw new Error('Generated env file failed validation');
  }

  if (hadExisting) {
    console.log(`  ✓ Backed up to ${backupPath}`);
  }
};

export const parseFrontendEnvTs = (src: string): EnvField[] => {
  const lines = src.split('\n');
  const fields: EnvField[] = [];

  let interfaceStart = -1;
  let interfaceEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('interface ImportMetaEnv')) {
      interfaceStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '}') {
          interfaceEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (interfaceStart === -1 || interfaceEnd === -1) return fields;

  const interfaceLines = lines.slice(interfaceStart + 1, interfaceEnd);
  const commentBuffer: string[] = [];
  const directiveBuffer: string[] = [];
  let i = 0;

  while (i < interfaceLines.length) {
    const line = interfaceLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('/**')) {
      const blockLines: string[] = [trimmed];

      if (!trimmed.includes('*/')) {
        i++;
        while (i < interfaceLines.length) {
          blockLines.push(interfaceLines[i].trim());
          if (interfaceLines[i].trim().includes('*/')) break;
          i++;
        }
      }

      fields.push({ kind: 'section', lines: blockLines });
      commentBuffer.length = 0;
      directiveBuffer.length = 0;
      i++;
      continue;
    }

    if (trimmed.startsWith('//')) {
      const commentText = trimmed.slice(2).trim();
      if (commentText.startsWith('@')) {
        directiveBuffer.push(commentText);
      } else {
        commentBuffer.push(commentText);
      }
      i++;
      continue;
    }

    if (!trimmed) {
      fields.push({ kind: 'blank' });
      commentBuffer.length = 0;
      directiveBuffer.length = 0;
      i++;
      continue;
    }

    const fieldMatch = trimmed.match(/^(?:readonly\s+)?(\w+)(\?)?:\s*(.+);$/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const isOptional = !!fieldMatch[2] || fieldMatch[3].includes('undefined');

      fields.push({
        kind: 'field',
        name: fieldName,
        optional: isOptional,
        directives: [...directiveBuffer],
        comments: [...commentBuffer],
      });

      commentBuffer.length = 0;
      directiveBuffer.length = 0;
    }

    i++;
  }

  return fields;
};

export const correctFrontendEnvReadonly = (src: string): string => {
  const lines = src.split('\n');
  let interfaceStart = -1;
  let interfaceEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('interface ImportMetaEnv')) {
      interfaceStart = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '}') {
          interfaceEnd = j;
          break;
        }
      }
      break;
    }
  }

  if (interfaceStart === -1 || interfaceEnd === -1) return src;

  for (let i = interfaceStart + 1; i < interfaceEnd; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(/^(\w+)(\?)?:\s*(.+);$/) && !trimmed.startsWith('readonly')) {
      const indent = lines[i].match(/^(\s*)/)?.[1] || '';
      lines[i] = `${indent}readonly ${trimmed}`;
    }
  }

  return lines.join('\n');
};

const generateFrontendEnv = async (): Promise<void> => {
  console.log('\n🎨 Generating frontend environment file...');

  if (!existsSync(FRONTEND_ENV_TS)) {
    console.warn('  ⚠ frontend/src/env.d.ts not found, skipping');
    return;
  }

  const src = readFileSync(FRONTEND_ENV_TS, 'utf-8');
  const corrected = correctFrontendEnvReadonly(src);

  if (corrected !== src) {
    writeFileSync(FRONTEND_ENV_TS, corrected);
    console.log('  ✓ Auto-corrected readonly in frontend/src/env.d.ts');
  }

  const fields = parseFrontendEnvTs(corrected);
  const existing = parseEnvFile(FRONTEND_ENV);
  const output = renderEnv(fields, existing);
  writeEnvSafe(FRONTEND_ENV, `${FRONTEND_ENV}.backup`, output, fields);

  console.log('  ✓ Generated frontend/.env');
};

const generateServerEnv = async (): Promise<void> => {
  console.log('\n🔧 Generating server environment file...');

  if (!existsSync(SERVER_ENV_TS)) {
    console.warn('  ⚠ server/env.ts not found, skipping');
    return;
  }

  const src = readFileSync(SERVER_ENV_TS, 'utf-8');
  const fields = parseEnvTs(src);
  const existing = parseEnvFile(SERVER_ENV);
  const output = renderEnv(fields, existing);
  writeEnvSafe(SERVER_ENV, `${SERVER_ENV}.backup`, output, fields);

  console.log('  ✓ Generated server/.env');
};

const generateEnv = async (): Promise<void> => {
  console.log('🚀 Generating environment files...');

  try {
    await generateServerEnv();
    await generateFrontendEnv();
    console.log('\n✅ Environment generation complete');
  } catch (error) {
    console.error('\n❌ Environment generation failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

export const description = 'Generate/update .env files from schema sources';
export const run = (_args: string[]) => generateEnv();
