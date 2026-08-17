import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runOnEventHooks } from '../../src/argus/hooks.js';
import { makeRepo } from '../helpers.js';

function hooksDir(projectRoot: string): string {
  return path.join(projectRoot, '.flightdeck', 'hooks', 'on-event');
}

function writeHook(projectRoot: string, filename: string, script: string): void {
  const dir = hooksDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), script, { mode: 0o755 });
}

describe('runOnEventHooks', () => {
  it('does nothing when no hook directory exists', () => {
    const fixture = makeRepo();
    try {
      expect(() =>
        runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', 'session-1', 'task X blocked')
      ).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('runs every *.sh hook with the event env vars set', () => {
    const fixture = makeRepo();
    const envFile = path.join(fixture.root, 'env-seen.txt');
    try {
      writeHook(
        fixture.root,
        '01-record.sh',
        `#!/bin/bash\necho "$FLIGHTDECK_EVENT|$FLIGHTDECK_ARGUS_ID|$FLIGHTDECK_SESSION|$FLIGHTDECK_MESSAGE" > "${envFile}"\n`
      );
      runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', 'session-1', 'task X blocked');
      const seen = fs.readFileSync(envFile, 'utf8').trim();
      expect(seen).toBe('task_blocked|argus-1|session-1|task X blocked');
    } finally {
      fixture.cleanup();
    }
  });

  it('omits FLIGHTDECK_SESSION when no session is related to the event', () => {
    const fixture = makeRepo();
    const envFile = path.join(fixture.root, 'env-seen.txt');
    try {
      writeHook(
        fixture.root,
        '01-record.sh',
        `#!/bin/bash\necho "session=[$FLIGHTDECK_SESSION]" > "${envFile}"\n`
      );
      runOnEventHooks(fixture.root, 'argus_paused', 'argus-1', null, '');
      expect(fs.readFileSync(envFile, 'utf8').trim()).toBe('session=[]');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not throw when a hook script fails', () => {
    const fixture = makeRepo();
    try {
      writeHook(fixture.root, '01-fail.sh', '#!/bin/bash\nexit 1\n');
      expect(() => runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', null, '')).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('ignores non-.sh files in the hook directory', () => {
    const fixture = makeRepo();
    const dir = hooksDir(fixture.root);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), 'not a hook');
      expect(() => runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', null, '')).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });
});
