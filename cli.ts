#!/usr/bin/env bun

import { generateEnv } from './src/commands/generate.ts';
import { runUpdate } from './src/commands/update.ts';

const command = process.argv[2];

switch (command) {
  case 'env:generate':
    await generateEnv();
    break;

  case 'update':
    await runUpdate(process.argv.slice(3));
    break;

  case 'help':
  case undefined:
    console.log(`
gyoza — hono-react-template tooling

Commands:
  env:generate          Generate/update .env files from schema sources
  update                Interactive dependency updater
  update --latest       Update to latest versions
  update -y             Skip confirmation prompt
  help                  Show this message
    `.trim());
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "gyoza help" for available commands.');
    process.exit(1);
}
