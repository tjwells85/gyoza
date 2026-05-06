import { gyoza } from '../gyoza.ts';
import * as build from './build.ts';
import { generateGroup } from './generate/index.ts';
import { initGroup } from './init/index.ts';
import * as update from './update.ts';

export const registry = gyoza('gyoza — hono-react-template tooling', (cmd) => ({
  generate: generateGroup,
  init:     initGroup,
  update:   cmd(update.description, update.run, update.flags),
  build:    cmd(build.description, build.run),
}));
