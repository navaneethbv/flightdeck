import fs from 'node:fs';
import path from 'node:path';

/** Resolve the operator's installed tools without searching the working directory. */
export function findExecutable(binary: string): string | null {
  if (!/^[\w.-]+$/.test(binary)) throw new Error('Expected an executable name without a path');
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, binary);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a fixed executable basename in an absolute operator PATH directory is inspected.
      if (!fs.statSync(candidate).isFile()) continue; // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Missing or non-executable entries do not shadow later installed tools.
    }
  }
  return null;
}

export function requireExecutable(binary: string): string {
  const executable = findExecutable(binary);
  if (!executable) throw new Error(`${binary} not found in absolute PATH directories`);
  return executable;
}
