import { gyoza } from '../../gyoza.ts';
import * as config from './config.ts';
import * as eslint from './eslint.ts';

export const initGroup = gyoza('Project initialization commands', (cmd) => ({
  config: cmd(config.description, config.run),
  eslint: cmd(eslint.description, eslint.run, eslint.flags),
}));

export type KnownInitCommand = keyof typeof initGroup.commands;
