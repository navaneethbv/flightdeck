import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.FLIGHTDECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-test-home-'));
