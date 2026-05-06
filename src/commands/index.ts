import type { Command } from '../types.ts';
import { envGenerateCommand } from './generate.ts';
import { updateCommand } from './update.ts';

export const commands: Command[] = [envGenerateCommand, updateCommand];
