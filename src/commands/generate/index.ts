import { gyoza } from '../../gyoza.ts';
import * as env from './env.ts';

export const generateGroup = gyoza('Code generation commands', (cmd) => ({
  env: cmd(env.description, env.run),
}));

export type KnownGenerateCommand = keyof typeof generateGroup.commands;
