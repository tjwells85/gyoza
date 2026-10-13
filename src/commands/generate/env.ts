import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PackageJson } from 'type-fest';
import { loadConfig, validateFrontendConfig, type FrontendBuildToolSetting } from '../../config.ts';
import { choose, confirm } from '../../prompt.ts';

const PROJECT_ROOT = process.cwd();
const SERVER_ENV_TS = join(PROJECT_ROOT, 'server/env.ts');
const SERVER_ENV = join(PROJECT_ROOT, 'server/.env');
const FRONTEND_DIR = join(PROJECT_ROOT, 'frontend');
const FRONTEND_ENV_TS = join(FRONTEND_DIR, 'src/env.d.ts');
const FRONTEND_ENV = join(FRONTEND_DIR, '.env');

type FrontendBuildTool = 'vite' | 'rsbuild';

const BUILD_TOOL_EXPECTED_PREFIX: Record<FrontendBuildTool, string> = {
  vite: 'VITE_',
  rsbuild: 'PUBLIC_',
};

const BUILD_TOOL_PACKAGE: Record<FrontendBuildTool, string> = {
  vite: 'vite',
  rsbuild: '@rsbuild/core',
};

const BUILD_TOOLS: readonly FrontendBuildTool[] = ['vite', 'rsbuild'];

const CONFIG_FILE_EXTENSIONS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'];

/** Every build tool with a config file in `frontendDir`. Both tools support the same `interface ImportMetaEnv` shape, so only the expected var prefix differs. */
export const detectFrontendBuildTools = (frontendDir: string): FrontendBuildTool[] =>
  BUILD_TOOLS.filter((tool) => CONFIG_FILE_EXTENSIONS.some((ext) => existsSync(join(frontendDir, `${tool}.config.${ext}`))));

/** Every build tool whose package is declared in `frontendDir/package.json` deps or devDeps. Missing/unparseable file → none. */
export const declaredFrontendBuildTools = (frontendDir: string): FrontendBuildTool[] => {
  const pkgPath = join(frontendDir, 'package.json');
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    return BUILD_TOOLS.filter((tool) => declared[BUILD_TOOL_PACKAGE[tool]] !== undefined);
  } catch {
    return [];
  }
};

export type BuildToolResolution =
  | { kind: 'resolved'; tool: FrontendBuildTool; source: 'config' | 'detected' | 'dependency' }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * An explicit setting wins outright. Under `'auto'`, a lone config file decides; when
 * both exist (e.g. a stub `vite.config.ts` kept for shadcn's CLI), the one tool declared
 * as a dependency decides. Anything still unclear is `ambiguous` — never a silent pick.
 */
export const resolveFrontendBuildTool = (setting: FrontendBuildToolSetting, frontendDir: string): BuildToolResolution => {
  if (setting !== 'auto') return { kind: 'resolved', tool: setting, source: 'config' };

  const detected = detectFrontendBuildTools(frontendDir);
  if (detected.length === 0) return { kind: 'none' };
  if (detected.length === 1) return { kind: 'resolved', tool: detected[0], source: 'detected' };

  const declared = declaredFrontendBuildTools(frontendDir);
  if (declared.length === 1) return { kind: 'resolved', tool: declared[0], source: 'dependency' };

  return { kind: 'ambiguous' };
};

/** Rsbuild's expected prefix is only its configured default; a custom `loadEnv({ prefixes })` isn't read here. */
export const warnPrefixMismatches = (fields: EnvField[], tool: FrontendBuildTool): void => {
  const expected = BUILD_TOOL_EXPECTED_PREFIX[tool];
  for (const field of fields) {
    if (field.kind === 'field' && !field.name.startsWith(expected)) {
      console.warn(`  ⚠ ${field.name} does not start with "${expected}" (expected for ${tool})`);
    }
  }
};

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

/** Locates the `interface ImportMetaEnv { ... }` block shared by all frontend env.d.ts helpers. */
const findImportMetaEnvBounds = (lines: string[]): { start: number; end: number } | undefined => {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('interface ImportMetaEnv')) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '}') return { start: i, end: j };
      }
      return undefined;
    }
  }
  return undefined;
};

export const parseFrontendEnvTs = (src: string): EnvField[] => {
  const lines = src.split('\n');
  const fields: EnvField[] = [];

  const bounds = findImportMetaEnvBounds(lines);
  if (!bounds) return fields;

  const interfaceLines = lines.slice(bounds.start + 1, bounds.end);
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
  const bounds = findImportMetaEnvBounds(lines);
  if (!bounds) return src;

  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(/^(\w+)(\?)?:\s*(.+);$/) && !trimmed.startsWith('readonly')) {
      const indent = lines[i].match(/^(\s*)/)?.[1] || '';
      lines[i] = `${indent}readonly ${trimmed}`;
    }
  }

  return lines.join('\n');
};

/**
 * Renames fields in `interface ImportMetaEnv` whose name uses the *other* known tool's
 * prefix to the given tool's expected one (`VITE_` <-> `PUBLIC_`). Only that clean swap is
 * attempted — a field with neither prefix is left alone, since there's nothing to swap it to.
 */
export const correctFrontendEnvPrefix = (src: string, tool: FrontendBuildTool): { corrected: string; renamed: [string, string][] } => {
  const lines = src.split('\n');
  const renamed: [string, string][] = [];

  const bounds = findImportMetaEnvBounds(lines);
  if (!bounds) return { corrected: src, renamed };

  const expectedPrefix = BUILD_TOOL_EXPECTED_PREFIX[tool];
  const otherPrefix = BUILD_TOOL_EXPECTED_PREFIX[tool === 'vite' ? 'rsbuild' : 'vite'];

  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const trimmed = lines[i].trim();
    const fieldMatch = trimmed.match(/^(readonly\s+)?(\w+)(\??):\s*(.+);$/);
    if (!fieldMatch) continue;

    const [, readonlyPart = '', name, optionalMark, rest] = fieldMatch;
    if (!name.startsWith(otherPrefix)) continue;

    const newName = expectedPrefix + name.slice(otherPrefix.length);
    const indent = lines[i].match(/^(\s*)/)?.[1] ?? '';
    lines[i] = `${indent}${readonlyPart}${newName}${optionalMark}: ${rest};`;
    renamed.push([name, newName]);
  }

  return { corrected: lines.join('\n'), renamed };
};

/** Turns a resolution into a tool to check against, prompting when both tools are plausible. `undefined` skips prefix checking. */
const pickFrontendBuildTool = async (setting: FrontendBuildToolSetting): Promise<FrontendBuildTool | undefined> => {
  const resolution = resolveFrontendBuildTool(setting, FRONTEND_DIR);

  if (resolution.kind === 'none') return undefined;

  if (resolution.kind === 'resolved') {
    if (resolution.source === 'dependency') {
      console.log(
        `  Build tool: ${resolution.tool} (both configs found; only ${BUILD_TOOL_PACKAGE[resolution.tool]} is a dependency)`,
      );
    }
    return resolution.tool;
  }

  console.log('  ⚠ Both vite.config.* and rsbuild.config.* found in frontend/, and package.json does not settle it');
  const hint = `    Set frontend.buildTool in gyoza.config.ts to skip this check`;

  if (!process.stdin.isTTY) {
    console.log('  (non-interactive — skipping prefix check)');
    console.log(hint);
    return undefined;
  }

  const tool = await choose('Which build tool does this frontend use?', BUILD_TOOLS);
  if (!tool) {
    console.log('  No build tool chosen — skipping prefix check');
    return undefined;
  }
  console.log(hint);
  return tool;
};

const generateFrontendEnv = async (buildToolSetting: FrontendBuildToolSetting): Promise<void> => {
  console.log('\n🎨 Generating frontend environment file...');

  if (!existsSync(FRONTEND_ENV_TS)) {
    console.warn('  ⚠ frontend/src/env.d.ts not found, skipping');
    return;
  }

  const src = readFileSync(FRONTEND_ENV_TS, 'utf-8');
  let workingSrc = correctFrontendEnvReadonly(src);

  if (workingSrc !== src) {
    writeFileSync(FRONTEND_ENV_TS, workingSrc);
    console.log('  ✓ Auto-corrected readonly in frontend/src/env.d.ts');
  }

  const buildTool = await pickFrontendBuildTool(buildToolSetting);
  const renameCandidates = buildTool ? correctFrontendEnvPrefix(workingSrc, buildTool).renamed : [];
  let renamedFields: [string, string][] = [];

  if (buildTool && renameCandidates.length > 0) {
    console.log(`  ⚠ ${renameCandidates.length} field(s) in frontend/src/env.d.ts use the wrong prefix for ${buildTool}:`);
    for (const [oldName, newName] of renameCandidates) {
      console.log(`    - ${oldName} -> ${newName}`);
    }

    if (process.stdin.isTTY) {
      const shouldRename = await confirm(`Rename to match ${buildTool}'s "${BUILD_TOOL_EXPECTED_PREFIX[buildTool]}" prefix?`);

      if (shouldRename) {
        workingSrc = correctFrontendEnvPrefix(workingSrc, buildTool).corrected;
        renamedFields = renameCandidates;
        writeFileSync(FRONTEND_ENV_TS, workingSrc);
        console.log('  ✓ Renamed fields in frontend/src/env.d.ts');
      }
    } else {
      console.log('  (non-interactive — leaving as-is)');
    }
  }

  const fields = parseFrontendEnvTs(workingSrc);

  if (buildTool) {
    const skipNames = new Set(renameCandidates.map(([oldName]) => oldName));
    warnPrefixMismatches(
      fields.filter((f) => !(f.kind === 'field' && skipNames.has(f.name))),
      buildTool,
    );
  }

  const existing = parseEnvFile(FRONTEND_ENV);
  for (const [oldName, newName] of renamedFields) {
    if (existing[oldName] !== undefined && existing[newName] === undefined) {
      existing[newName] = existing[oldName];
    }
  }

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
  const config = await loadConfig(PROJECT_ROOT);

  const { errors } = validateFrontendConfig(config);
  if (errors.length > 0) {
    console.error('\n❌ Invalid frontend config in gyoza.config.ts:');
    for (const error of errors) console.error(`  ✗ ${error}`);
    process.exit(1);
  }

  console.log('🚀 Generating environment files...');

  try {
    await generateServerEnv();
    await generateFrontendEnv(config.frontend?.buildTool ?? 'auto');
    console.log('\n✅ Environment generation complete');
  } catch (error) {
    console.error('\n❌ Environment generation failed:');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

export const description = 'Generate/update .env files from schema sources';
export const run = (_args: string[]) => generateEnv();
