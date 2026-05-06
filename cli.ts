#!/usr/bin/env bun

import { registry } from './src/commands/index.ts';
import { isCommand } from './src/gyoza.ts';
import type { Command, CommandGroup, GyozaNode } from './src/gyoza.ts';

const printGroupHelp = (group: CommandGroup, path: string[]): void => {
  const isRoot = path.length === 1;
  const keys = Object.keys(group.commands);
  const nameWidth = Math.max(...keys.map(k => k.length), isRoot ? 'help'.length : 0) + 2;
  const lines = [
    isRoot ? group.description : `${path.join(' ')} — ${group.description}`,
    '',
    'Commands:',
  ];

  for (const [name, node] of Object.entries(group.commands)) {
    lines.push(`  ${name.padEnd(nameWidth)}${node.description}`);
    if (isCommand(node)) {
      for (const { flag, description } of node.flags ?? []) {
        lines.push(`    ${flag.padEnd(nameWidth)}${description}`);
      }
    }
  }

  if (isRoot) lines.push(`  ${'help'.padEnd(nameWidth)}Show this message`);

  lines.push('');
  lines.push(
    isRoot
      ? 'Run "gyoza <command> --help" for more information on a command.'
      : `Run "${path.join(' ')} <command> --help" for more information on a command.`,
  );

  console.log(lines.join('\n'));
};

const printCommandHelp = (cmd: Command, path: string[]): void => {
  const usage = path.join(' ');
  const hasFlags = (cmd.flags?.length ?? 0) > 0;
  const lines = [`${usage} — ${cmd.description}`, '', `Usage: ${usage}${hasFlags ? ' [flags]' : ''}`];

  if (hasFlags) {
    const pad = Math.max(...(cmd.flags ?? []).map(f => f.flag.length)) + 2;
    lines.push('', 'Flags:');
    for (const { flag, description } of cmd.flags ?? []) {
      lines.push(`  ${flag.padEnd(pad)}${description}`);
    }
  }

  console.log(lines.join('\n'));
};

const dispatch = async (node: GyozaNode, path: string[], args: string[]): Promise<void> => {
  if (isCommand(node)) {
    if (args[0] === '--help' || args[0] === 'help') {
      printCommandHelp(node, path);
      return;
    }
    await node.run(args);
    return;
  }

  const [next, ...rest] = args;

  if (!next || next === '--help' || next === 'help') {
    printGroupHelp(node, path);
    return;
  }

  const child = node.commands[next];

  if (!child) {
    console.error(`Unknown command: ${[...path, next].join(' ')}`);
    console.error(`Run "${path.join(' ')} --help" for available commands.`);
    process.exit(1);
  }

  await dispatch(child, [...path, next], rest);
};

await dispatch(registry, ['gyoza'], process.argv.slice(2));
