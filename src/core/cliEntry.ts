import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function cliEntryPath(): string {
  const override = process.env.FLIGHTDECK_CLI_PATH;
  if (override) return override;
  const candidate = path.resolve(here, '..', 'cli', 'index.js');
  if (fs.existsSync(candidate)) return candidate;
  return 'deck';
}
