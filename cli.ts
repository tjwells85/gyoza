#!/usr/bin/env bun

import { commands } from './src/commands/index.ts';
import type { Command } from './src/types.ts';

const printHelp = (cmds: Command[]): void => {
  const pad = Math.max(...cmds.map(c => c.name.length), 'help'.length) + 2;
  const lines = ['gyoza — hono-react-template tooling', '', 'Commands:'];

  for (const cmd of cmds) {
    lines.push(`  ${cmd.name.padEnd(pad)}${cmd.description}`);
    for (const { flag, description } of cmd.flags ?? []) {
      lines.push(`    ${flag.padEnd(pad)}${description}`);
    }
  }

  lines.push(`  ${'help'.padEnd(pad)}Show this message`);
  console.log(lines.join('\n'));
};

const [, , commandName, ...args] = process.argv;

if (!commandName || commandName === 'help') {
  printHelp(commands);
  process.exit(0);
}

const command = commands.find(c => c.name === commandName);

if (!command) {
  console.error(`Unknown command: ${commandName}`);
  console.error('Run "gyoza help" for available commands.');
  process.exit(1);
}

await command.run(args);
