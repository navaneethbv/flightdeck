import { describe, it, expect } from 'vitest';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';

/** Records every argv the wrapper would pass to tmux. */
function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('Tmux', () => {
  it('detects a usable tmux', () => {
    const { run } = fakeRunner([{ status: 0, stdout: 'tmux 3.4\n', stderr: '' }]);
    expect(new Tmux(run).hasTmux()).toBe(true);
  });

  it('reports no tmux when the binary is missing', () => {
    const { run } = fakeRunner([{ status: 127, stdout: '', stderr: 'not found' }]);
    expect(new Tmux(run).hasTmux()).toBe(false);
  });

  it('creates a detached session running the given command', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).newSession('fd-abc', '/repo', ['deck', 'fleet', 'console']);
    expect(calls[0]).toEqual([
      'new-session', '-d', '-s', 'fd-abc', '-c', '/repo', '--', 'deck', 'fleet', 'console',
    ]);
  });

  it('creates a detached session with an explicit window size when one is given', () => {
    const calls: string[][] = [];
    const tmux = new Tmux((args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    });
    tmux.newSession('fd-1', '/tmp/p', ['node', 'cli.js'], { width: 200, height: 50 });
    expect(calls[0]).toEqual([
      'new-session', '-d', '-s', 'fd-1', '-c', '/tmp/p', '-x', '200', '-y', '50', '--', 'node', 'cli.js',
    ]);
  });

  it('omits the size flags when no size is given', () => {
    const calls: string[][] = [];
    const tmux = new Tmux((args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    });
    tmux.newSession('fd-1', '/tmp/p', ['node', 'cli.js']);
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'fd-1', '-c', '/tmp/p', '--', 'node', 'cli.js']);
  });

  it('returns the pane id when splitting', () => {
    const { run, calls } = fakeRunner([{ status: 0, stdout: '%7\n', stderr: '' }]);
    const paneId = new Tmux(run).splitWindow('fd-abc', '/repo', ['deck', 'session', 'follow', 's1']);
    expect(paneId).toBe('%7');
    expect(calls[0]).toEqual([
      'split-window', '-t', 'fd-abc:0', '-c', '/repo', '-P', '-F', '#{pane_id}',
      '--', 'deck', 'session', 'follow', 's1',
    ]);
  });

  it('passes environment through -e flags rather than an env prefix', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).respawnPane('%7', '/repo', ['claude'], { CLAUDE_CONFIG_DIR: '/profiles/a' });
    expect(calls[0]).toEqual([
      'respawn-pane', '-k', '-t', '%7', '-c', '/repo',
      '-e', 'CLAUDE_CONFIG_DIR=/profiles/a', '--', 'claude',
    ]);
    // Only non-secret values ever travel this way; see the global constraint
    // on tokens. The command itself stays free of environment noise.
    const commandPart = calls[0].slice(calls[0].indexOf('--') + 1);
    expect(commandPart).toEqual(['claude']);
  });

  it('parses list-panes output including panes with no session tag', () => {
    const { run } = fakeRunner([
      { status: 0, stdout: '%1\t\tconsole\n%2\ts-abc\tworker-1\n', stderr: '' },
    ]);
    expect(new Tmux(run).listPanes('fd-abc')).toEqual([
      { paneId: '%1', sessionId: null, title: 'console' },
      { paneId: '%2', sessionId: 's-abc', title: 'worker-1' },
    ]);
  });

  it('tags a pane with its flightdeck session id', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).setPaneSession('%2', 's-abc');
    expect(calls[0]).toEqual(['set-option', '-p', '-t', '%2', '@fd_session', 's-abc']);
  });

  it('switches instead of attaching when already inside tmux', () => {
    // `attach-session` from inside tmux errors out rather than nesting, so the
    // caller needs a different argv for that case.
    const { run } = fakeRunner();
    const tmux = new Tmux(run);
    expect(tmux.attachArgs('fd-abc')).toEqual(['attach-session', '-t', 'fd-abc']);
    expect(tmux.switchClientArgs('fd-abc')).toEqual(['switch-client', '-t', 'fd-abc']);
  });

  it('reports session existence from the exit status', () => {
    const present = fakeRunner([{ status: 0, stdout: '', stderr: '' }]);
    expect(new Tmux(present.run).sessionExists('fd-abc')).toBe(true);
    const absent = fakeRunner([{ status: 1, stdout: '', stderr: 'no such session' }]);
    expect(new Tmux(absent.run).sessionExists('fd-abc')).toBe(false);
  });
});
