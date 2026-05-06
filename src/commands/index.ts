import type { Command } from '../types.ts';
import { buildCommand } from './build.ts';
import { envGenerateCommand } from './generate.ts';
import { initConfigCommand } from './init-config.ts';
import { updateCommand } from './update.ts';

export const commands: Command[] = [envGenerateCommand, updateCommand, buildCommand, initConfigCommand];
