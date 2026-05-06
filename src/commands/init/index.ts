import { gyoza } from '../../gyoza.ts';
import * as config from './config.ts';

export const initGroup = gyoza('Project initialization commands', (cmd) => ({
  config: cmd(config.description, config.run),
}));
