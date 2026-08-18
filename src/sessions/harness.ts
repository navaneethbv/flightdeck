import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  headlessArgs(prompt: string, opts: { autonomy?: boolean; model?: string }): string[];
  /**
   * Args for headless session spawns, chosen so model and usage can be parsed
   * from the output stream. Differs from `headlessArgs` (used by playbook
   * `llm` steps, which keep plain text) only where the harness needs a
   * structured output format to report usage.
   */
  sessionArgs(prompt: string, opts: { autonomy?: boolean; model?: string }): string[];
  writeMcpConfig(session: Session, worktreeDir: string, extraEnv?: Record<string, string>): void;
  /** Extract telemetry fields from one line of harness output. */
  telemetry(line: string): TelemetryExtraction | null;
  /** Render one line into readable log text, or null to suppress it. */
  renderLine(line: string, stream: 'stdout' | 'stderr'): string | null;
  /** The harness's interactive login subcommand (e.g. `claude login`). */
  loginArgs(): string[];
  /**
   * Credential files a completed OAuth session leaves behind. Presence is a
   * best-effort "already logged in" signal; absence only means "run login",
   * never that login is impossible. Honours profile dirs and per-harness env
   * overrides so a custom config dir is checked in the right place.
   */
  authFiles(env?: NodeJS.ProcessEnv): string[];
  /**
   * Best-effort detection of a real provider rate limit in one invocation's
   * combined output, returning a suggested backoff in milliseconds, or null
   * when nothing matches. No API exposes a structured retry-after in headless
   * mode for either harness today, so this is a keyword heuristic with a
   * fixed backoff, the same kind of self-imposed, observed-behavior estimate
   * the token budget itself already is. Revisit once real throttle output has
   * been captured from each harness. Only implemented for brain-eligible
   * harnesses (claude, codex); a worker harness never triggers a brain-budget
   * concern.
   */
  detectRateLimit?(output: string): number | null;
}

/**
 * Whether `binary` resolves through PATH. The `which` command is tried first
 * for exact OS semantics; when PATH is trimmed so hard that `which` itself is
 * not resolvable (isolated tests, minimal containers), a direct scan of each
 * PATH entry for an executable file stands in.
 */
function which(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'pipe' });
    return true;
  } catch {
    // `which` missing or it reported not found; scan PATH below.
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, binary);
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
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
      ...extraEnv,
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

const RATE_LIMIT_PATTERNS = [/rate limit/i, /usage limit reached/i, /too many requests/i, /\b429\b/];
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A rate-limit phrase is only trusted on a raw (non-JSON) line, or on a
 * structured `type: "error"` event. Both harnesses emit well-formed
 * JSON-lines on success, and model text or usage numbers live inside string
 * or numeric fields, never as the line itself, so a keyword match inside a
 * normal successful event (a plan discussing rate limits, a token count that
 * happens to be 429) is not treated as a real provider throttle.
 */
function lineLooksLikeRateLimit(line: string): boolean {
  if (!RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(line))) return false;
  const parsed = tryParseJsonLine(line);
  if (parsed === null) return true;
  return parsed.type === 'error';
}

function detectRateLimitByKeyword(output: string): number | null {
  return output.split('\n').some(lineLooksLikeRateLimit) ? DEFAULT_RATE_LIMIT_BACKOFF_MS : null;
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
    if (opts.model) args.push('--model', opts.model);
    return args;
  },
  telemetry: parseClaudeLine,
  renderLine: renderClaudeLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    writeJson(path.join(worktreeDir, '.mcp.json'), mcpJsonShape(session, worktreeDir, extraEnv));
  },
  loginArgs: () => ['login'],
  authFiles(env) {
    const dir =
      env?.CLAUDE_CONFIG_DIR ?? loadConfig().profileDir.claude ?? path.join(env?.HOME ?? os.homedir(), '.claude');
    return [path.join(dir, '.credentials.json')];
  },
  detectRateLimit: detectRateLimitByKeyword,
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
  headlessArgs: (prompt, opts) => {
    const args = ['exec', '--json'];
    // `--approve-for-me` already routes approvals through the workspace-write
    // sandbox on its own; codex's own CLI rejects an explicit `--sandbox`
    // alongside it ("cannot be used with '--approve-for-me'").
    if (opts.autonomy) args.push('--approve-for-me');
    if (opts.model) args.push('--model', opts.model);
    args.push('--', prompt);
    return args;
  },
  sessionArgs: (prompt, opts) => {
    const args = ['exec', '--json'];
    // `--approve-for-me` already routes approvals through the workspace-write
    // sandbox on its own; codex's own CLI rejects an explicit `--sandbox`
    // alongside it ("cannot be used with '--approve-for-me'").
    if (opts.autonomy) args.push('--approve-for-me');
    if (opts.model) args.push('--model', opts.model);
    args.push('--', prompt);
    return args;
  },
  telemetry: parseCodexLine,
  renderLine: renderCodexLine,
  writeMcpConfig(session, worktreeDir, extraEnv) {
    writeJson(path.join(worktreeDir, 'mcp.json'), mcpJsonShape(session, worktreeDir, extraEnv));
  },
  loginArgs: () => ['login'],
  authFiles(env) {
    const dir = env?.CODEX_HOME ?? loadConfig().profileDir.codex ?? path.join(env?.HOME ?? os.homedir(), '.codex');
    return [path.join(dir, 'auth.json')];
  },
  detectRateLimit: detectRateLimitByKeyword,
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
    const args = ['run'];
    if (opts.autonomy) args.push('--auto');
    if (opts.model) args.push('--model', opts.model);
    args.push('--', prompt);
    return args;
  },
  sessionArgs: (prompt, opts) => {
    const args = ['run', '--format', 'json', '--print-logs'];
    if (opts.autonomy) args.push('--auto');
    if (opts.model) args.push('--model', opts.model);
    args.push('--', prompt);
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
  loginArgs: () => ['auth', 'login'],
  authFiles(env) {
    const profileDir = loadConfig().profileDir.opencode;
    if (profileDir) return [path.join(profileDir, 'opencode', 'auth.json')];
    const base = env?.XDG_DATA_HOME ?? path.join(env?.HOME ?? os.homedir(), '.local', 'share');
    return [path.join(base, 'opencode', 'auth.json')];
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
    // gemini exposes no verified model flag, so opts.model is ignored here.
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
  loginArgs: () => ['login'],
  authFiles(env) {
    const dir =
      env?.GEMINI_CONFIG_DIR ??
      env?.GEMINI_HOME ??
      loadConfig().profileDir.gemini ??
      path.join(env?.HOME ?? os.homedir(), '.gemini');
    return [path.join(dir, 'auth.json')];
  },
};

export const adapters: Record<HarnessKind, HarnessAdapter> = { claude, codex, opencode, gemini };

export function getAdapter(kind: HarnessKind): HarnessAdapter {
  return adapters[kind];
}

export function detectedHarnesses(): HarnessKind[] {
  return (Object.keys(adapters) as HarnessKind[]).filter((k) => adapters[k].detect());
}
