import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliEntryPath } from '../core/cliEntry.js';
import { loadConfig } from '../core/config.js';
import type { HarnessKind, Session } from '../core/types.js';
import {
  parseClaudeLine,
  parseCodexLine,
  parseGeminiLine,
  parseOpencodeLine,
  renderClaudeLine,
  renderCodexLine,
  renderGeminiLine,
  renderOpencodeLine,
  type TelemetryExtraction,
} from './telemetry.js';

export interface HarnessAdapter {
  kind: HarnessKind;
  binary: string;
  displayName: string;
  detect(): boolean;
  profileEnv(session: Session, extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  interactiveArgs(): string[];
  headlessArgs(prompt: string, opts: { autonomy?: boolean }): string[];
  /**
   * Args for headless session spawns, chosen so model and usage can be parsed
   * from the output stream. Differs from `headlessArgs` (used by playbook
   * `llm` steps, which keep plain text) only where the harness needs a
   * structured output format to report usage.
   */
  sessionArgs(prompt: string, opts: { autonomy?: boolean }): string[];
  writeMcpConfig(session: Session, worktreeDir: string, extraEnv?: Record<string, string>): void;
  /** Extract telemetry fields from one line of harness output. */
  telemetry(line: string): TelemetryExtraction | null;
  /** Render one line into readable log text, or null to suppress it. */
  renderLine(line: string, stream: 'stdout' | 'stderr'): string | null;
}

function which(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function mcpServerArgs(session: Session, extraEnv?: Record<string, string>): { command: string; args: string[]; env: Record<string, string> } {
  const entry = cliEntryPath();
  const args = [
    entry,
    'mcp',
    'serve',
    '--session',
    session.id,
    '--token',
    session.token,
    '--project',
    session.projectRoot,
  ];
  return {
    command: process.execPath,
    args,
    env: {
      FLIGHTDECK_SESSION_TOKEN: session.token,
      ...(extraEnv ?? {}),
    },
  };
}

function mcpJsonShape(session: Session, _worktreeDir: string, extraEnv?: Record<string, string>): { mcpServers: Record<string, unknown> } {
  const srv = mcpServerArgs(session, extraEnv);
  return {
    mcpServers: {
      flightdeck: {
        command: srv.command,
        args: srv.args,
        env: srv.env,
      },
    },
  };
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const claude: HarnessAdapter = {
  kind: 'claude',
  binary: 'claude',
  displayName: 'Claude Code',
  detect: () => which('claude'),
  profileEnv(session, extraEnv) {
    const env: Record<string, string> = {};
    const dir = loadConfig().profileDir.claude;
    if (dir) env.CLAUDE_CONFIG_DIR = dir;
    return { ...env, ...extraEnv };
  },
  interactiveArgs: () => [],
  headlessArgs: (prompt, opts) => {
    const args = ['-p', prompt, '--output-format', 'text'];
    if (opts.autonomy) args.push('--permission-mode', 'acceptEdits');
    return args;
  },
  sessionArgs: (prompt, opts) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (opts.autonomy) args.push('--permission-mode', 'acceptEdits');
    return args;
  },
  telemetry: parseClaudeLine,
  renderLine: renderClaudeLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    writeJson(path.join(worktreeDir, '.mcp.json'), mcpJsonShape(session, worktreeDir, extraEnv));
  },
};

const codex: HarnessAdapter = {
  kind: 'codex',
  binary: 'codex',
  displayName: 'OpenAI Codex',
  detect: () => which('codex'),
  profileEnv(session, extraEnv) {
    const env: Record<string, string> = {};
    const dir = loadConfig().profileDir.codex;
    if (dir) env.CODEX_HOME = dir;
    return { ...env, ...extraEnv };
  },
  interactiveArgs: () => [],
  headlessArgs: (prompt, _opts) => {
    const args = ['exec', '--json', prompt];
    return args;
  },
  sessionArgs: (prompt, _opts) => {
    const args = ['exec', '--json', prompt];
    return args;
  },
  telemetry: parseCodexLine,
  renderLine: renderCodexLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    writeJson(path.join(worktreeDir, 'mcp.json'), mcpJsonShape(session, worktreeDir, extraEnv));
  },
};

const opencode: HarnessAdapter = {
  kind: 'opencode',
  binary: 'opencode',
  displayName: 'OpenCode',
  detect: () => which('opencode'),
  profileEnv(session, extraEnv) {
    const env: Record<string, string> = {};
    const dir = loadConfig().profileDir.opencode;
    if (dir) env.XDG_DATA_HOME = dir;
    return { ...env, ...extraEnv };
  },
  interactiveArgs: () => [],
  headlessArgs: (prompt, opts) => {
    const args = ['run', prompt];
    if (opts.autonomy) args.push('--permission', 'allow');
    return args;
  },
  sessionArgs: (prompt, opts) => {
    const args = ['run', '--format', 'json', '--print-logs', prompt];
    if (opts.autonomy) args.push('--permission', 'allow');
    return args;
  },
  telemetry: parseOpencodeLine,
  renderLine: renderOpencodeLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    const srv = mcpServerArgs(session, extraEnv);
    const cfg = {
      mcp: {
        flightdeck: {
          type: 'local',
          command: [srv.command, ...srv.args],
          env: srv.env,
          enabled: true,
        },
      },
    };
    writeJson(path.join(worktreeDir, 'opencode.json'), cfg);
  },
};

const gemini: HarnessAdapter = {
  kind: 'gemini',
  binary: 'gemini',
  displayName: 'Google Gemini',
  detect: () => which('gemini'),
  profileEnv(session, extraEnv) {
    const env: Record<string, string> = {};
    const dir = loadConfig().profileDir.gemini;
    if (dir) {
      env.GEMINI_CONFIG_DIR = dir;
      env.GEMINI_HOME = dir;
    }
    return { ...env, ...extraEnv };
  },
  interactiveArgs: () => [],
  headlessArgs: (prompt, opts) => {
    const args = ['run', prompt];
    if (opts.autonomy) args.push('--auto-approve');
    return args;
  },
  sessionArgs: (prompt, opts) => {
    const args = ['run', prompt];
    if (opts.autonomy) args.push('--auto-approve');
    return args;
  },
  telemetry: parseGeminiLine,
  renderLine: renderGeminiLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    writeJson(path.join(worktreeDir, '.mcp.json'), mcpJsonShape(session, worktreeDir, extraEnv));
    const geminiDir = path.join(worktreeDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    writeJson(path.join(geminiDir, 'settings.json'), mcpJsonShape(session, worktreeDir, extraEnv));
  },
};

export const adapters: Record<HarnessKind, HarnessAdapter> = { claude, codex, opencode, gemini };

export function getAdapter(kind: HarnessKind): HarnessAdapter {
  return adapters[kind];
}

export function detectedHarnesses(): HarnessKind[] {
  return (Object.keys(adapters) as HarnessKind[]).filter((k) => adapters[k].detect());
}
