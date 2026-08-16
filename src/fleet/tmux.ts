import { spawnSync } from 'node:child_process';

export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type TmuxRunner = (args: string[]) => TmuxResult;

export interface PaneInfo {
  paneId: string;
  /** The flightdeck session this pane follows, or null for the console pane. */
  sessionId: string | null;
  title: string;
}

export const defaultRunner: TmuxRunner = (args) => {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const WINDOW = ':0';

/**
 * The only code in the repository that shells out to tmux. Every method is a
 * single invocation, and the runner is injected so tests assert argv without
 * tmux installed.
 */
export class Tmux {
  constructor(private readonly run: TmuxRunner = defaultRunner) {}

  hasTmux(): boolean {
    return this.run(['-V']).status === 0;
  }

  sessionExists(name: string): boolean {
    return this.run(['has-session', '-t', name]).status === 0;
  }

  newSession(name: string, cwd: string, command: string[]): void {
    this.run(['new-session', '-d', '-s', name, '-c', cwd, '--', ...command]);
  }

  /** Returns the new pane's id, for example `%7`. */
  splitWindow(name: string, cwd: string, command: string[]): string {
    const result = this.run([
      'split-window', '-t', `${name}${WINDOW}`, '-c', cwd, '-P', '-F', '#{pane_id}',
      '--', ...command,
    ]);
    return result.stdout.trim();
  }

  /**
   * Replaces a pane's process. Environment goes through `-e` flags rather than
   * an `env KEY=VAL` prefix, because argv is visible to `ps` and a session
   * token must never appear there. This is why tmux 3.0 is the floor.
   */
  respawnPane(paneId: string, cwd: string, command: string[], env: Record<string, string> = {}): void {
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    this.run(['respawn-pane', '-k', '-t', paneId, '-c', cwd, ...envFlags, '--', ...command]);
  }

  killPane(paneId: string): void {
    this.run(['kill-pane', '-t', paneId]);
  }

  killSessionByName(name: string): void {
    this.run(['kill-session', '-t', name]);
  }

  listPanes(name: string): PaneInfo[] {
    const result = this.run([
      'list-panes', '-t', `${name}${WINDOW}`, '-F', '#{pane_id}\t#{@fd_session}\t#{pane_title}',
    ]);
    if (result.status !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [paneId, sessionId, title] = line.split('\t');
        return {
          paneId,
          sessionId: sessionId ? sessionId : null,
          title: title ?? '',
        };
      });
  }

  setPaneSession(paneId: string, sessionId: string): void {
    this.run(['set-option', '-p', '-t', paneId, '@fd_session', sessionId]);
  }

  setPaneTitle(paneId: string, title: string): void {
    this.run(['select-pane', '-t', paneId, '-T', title]);
  }

  selectLayout(name: string, layout = 'tiled'): void {
    this.run(['select-layout', '-t', `${name}${WINDOW}`, layout]);
  }

  /** Argv for attaching from outside tmux. The CLI spawns this with stdio inherited. */
  attachArgs(name: string): string[] {
    return ['attach-session', '-t', name];
  }

  /**
   * Argv for moving an existing client to this session. `attach-session` from
   * inside tmux refuses to nest, so a caller already in tmux must switch.
   */
  switchClientArgs(name: string): string[] {
    return ['switch-client', '-t', name];
  }
}
