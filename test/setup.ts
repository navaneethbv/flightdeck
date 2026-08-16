import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.FLIGHTDECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-test-home-'));
// cliEntryPath() honours FLIGHTDECK_CLI_PATH, and the fleet tmux e2e spawns
// `deck ...` inside real panes. Point it at the built CLI so those panes run
// a real entry point instead of a bare `deck` that cannot be resolved.
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.FLIGHTDECK_CLI_PATH = path.resolve(here, '..', 'dist', 'cli', 'index.js');
