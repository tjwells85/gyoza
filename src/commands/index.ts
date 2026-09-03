import { gyoza } from '../gyoza.ts';
import * as add from './add.ts';
import * as build from './build.ts';
import * as deploy from './deploy.ts';
import { generateGroup } from './generate/index.ts';
import { initGroup } from './init/index.ts';
import * as remove from './remove.ts';
import * as update from './update.ts';
import * as upgrade from './upgrade.ts';

export const registry = gyoza('gyoza — hono-react-template tooling', (cmd) => ({
  generate: generateGroup,
  init:     initGroup,
  add:      cmd(add.description, add.run, add.flags),
  remove:   cmd(remove.description, remove.run, remove.flags),
  update:   cmd(update.description, update.run, update.flags),
  upgrade:  cmd(upgrade.description, upgrade.run),
  build:    cmd(build.description, build.run),
  deploy:   cmd(deploy.description, deploy.run, deploy.flags),
}));
