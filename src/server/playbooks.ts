import fs from 'node:fs';
import path from 'node:path';
import { playbooksDir, globalPlaybooksDir } from '../core/paths.js';
import { BUILTIN_PLAYBOOKS } from '../playbooks/templates.js';
import { parsePlaybookYaml } from '../playbooks/parser.js';
import type { Playbook } from '../playbooks/types.js';
import { RequestError } from './request-body.js';

/** Dashboard actions select named playbooks, never arbitrary filesystem paths. */
export function readDashboardPlaybook(projectRoot: string, name: string): Playbook | null {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new RequestError(400, 'Invalid playbook name');
  }
  if (Object.hasOwn(BUILTIN_PLAYBOOKS, name)) {
    return parsePlaybookYaml(BUILTIN_PLAYBOOKS[name], name);
  }
  for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
    const file = path.join(dir, `${name}.yml`);
    if (!fs.existsSync(file)) continue;
    if (path.dirname(fs.realpathSync(file)) !== fs.realpathSync(dir)) {
      throw new RequestError(400, 'Playbook is outside its configured directory');
    }
    return parsePlaybookYaml(fs.readFileSync(file, 'utf8'), name);
  }
  return null;
}
