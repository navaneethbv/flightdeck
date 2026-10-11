import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { playbooksDir, globalPlaybooksDir } from '../core/paths.js';
import { BUILTIN_PLAYBOOKS } from './templates.js';
import { parsePlaybookYaml } from './parser.js';
import type { Playbook } from './types.js';

const builtins = new Map(Object.entries(BUILTIN_PLAYBOOKS));

function validateName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error('Invalid playbook name');
  }
}

/** Named actions never resolve arbitrary filesystem paths or linked files. */
export function readNamedPlaybook(projectRoot: string, name: string): Playbook | null {
  validateName(name);
  const builtin = builtins.get(name);
  if (builtin !== undefined) return parsePlaybookYaml(builtin, name);
  for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
    const file = path.join(dir, `${name}.yml`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The validated name cannot contain separators; only configured playbook directories are searched.
    if (!fs.existsSync(file)) continue; // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the directory entry itself so linked files can be rejected before opening.
    if (fs.lstatSync(file).isSymbolicLink()) { // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
      throw new Error('Playbook symlinks are not allowed');
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A validated basename and O_NOFOLLOW prevent path traversal and leaf symlink substitution.
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the already opened descriptor, never a caller-supplied path.
      return parsePlaybookYaml(fs.readFileSync(descriptor, 'utf8'), name); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return null;
}

export function saveNamedPlaybook(projectRoot: string, name: string, content: string): void {
  validateName(name);
  parsePlaybookYaml(content, name);
  const dir = playbooksDir(projectRoot);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This is the fixed playbooks directory under the configured project root.
  fs.mkdirSync(dir, { recursive: true }); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Canonical paths are required to check that the configured directory has not escaped the project.
  const relative = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(dir)); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  if (relative !== path.join('.flightdeck', 'playbooks')) throw new Error('Playbook directory must be inside its project');
  const file = path.join(dir, `${name}.yml`);
  let mode = 0o600;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The basename is validated, the parent is contained, and symlinks are rejected.
    const current = fs.lstatSync(file); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    if (!current.isFile()) throw new Error('Playbook must be a regular file');
    mode = current.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(dir, `.${randomUUID()}.tmp`);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A generated UUID filename is created exclusively inside the checked directory.
    fs.writeFileSync(temporary, content, { flag: 'wx', mode }); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the exclusively created temporary file receives the preserved permissions.
    fs.chmodSync(temporary, mode); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Both paths share the checked parent; the destination is a validated basename and rename does not follow it.
    fs.renameSync(temporary, file); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
