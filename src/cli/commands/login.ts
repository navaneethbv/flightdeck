import { Command } from 'commander';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { HARNESSES, isHarnessKind, type HarnessKind, type Session } from '../../core/types.js';
import { getAdapter } from '../../sessions/harness.js';
import { printJson, handleError } from '../util.js';

type Opts = Record<string, string | boolean | undefined>;

export interface LoginReport {
  kind: HarnessKind;
  installed: boolean;
  action: 'login' | 'check';
  ok: boolean;
  exitCode: number | null;
  /** `check` mode only: whether a persisted credential file was found. */
  authenticated?: boolean;
}

function isInstalled(kind: HarnessKind): boolean {
  return getAdapter(kind).detect();
}

function hasCredentials(kind: HarnessKind): boolean {
  return getAdapter(kind).authFiles().some((file) => fs.existsSync(file));
}

/**
 * Run one harness's interactive login flow. In interactive (non-JSON) mode the
 * harness stdio is inherited so a browser OAuth flow works; in `--json` mode
 * the harness output is captured and discarded so secrets it prints never
 * reach a log or the emitted payload.
 */
function runLoginFlow(kind: HarnessKind, inherit: boolean): { ok: boolean; exitCode: number | null } {
  const adapter = getAdapter(kind);
  const result = spawnSync(adapter.binary, adapter.loginArgs(), {
    stdio: inherit ? 'inherit' : 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ...adapter.profileEnv({} as Session) },
  });
  return { ok: result.status === 0, exitCode: result.status ?? null };
}

export function registerLogin(program: Command): void {
  program
    .command('login')
    .description('Authenticate your coding-agent harnesses (claude, codex, opencode, gemini)')
    .argument('[harness...]', 'harnesses to log in; defaults to every installed harness')
    .option('--check', 'report auth status without running any login flow')
    .option('--json', 'emit machine-readable output')
    .action((harnesses: string[], opts: Opts) => {
      try {
        const check = opts.check === true;

        let targets: HarnessKind[];
        if (harnesses.length > 0) {
          for (const h of harnesses) {
            if (!isHarnessKind(h)) throw new Error(`unknown harness "${h}"`);
          }
          targets = harnesses as HarnessKind[];
        } else {
          targets = HARNESSES.filter(isInstalled);
        }

        if (targets.length === 0) {
          const message = 'no coding-agent harnesses detected (claude, codex, opencode, gemini)';
          if (opts.json) {
            printJson({ ok: true, results: [] });
            return;
          }
          process.stdout.write(`${message}\n`);
          return;
        }

        const results: LoginReport[] = [];
        for (const kind of targets) {
          if (check) {
            const installed = isInstalled(kind);
            const authenticated = installed && hasCredentials(kind);
            results.push({ kind, installed, action: 'check', ok: authenticated, exitCode: null, authenticated });
          } else if (!isInstalled(kind)) {
            results.push({ kind, installed: false, action: 'login', ok: false, exitCode: null });
          } else {
            const { ok, exitCode } = runLoginFlow(kind, opts.json !== true);
            results.push({ kind, installed: true, action: 'login', ok, exitCode });
          }
        }

        const allOk = results.every((r) => r.ok);
        if (opts.json) {
          printJson({ ok: allOk, results });
          if (!allOk) process.exitCode = 1;
          return;
        }

        for (const r of results) {
          if (!r.installed) {
            process.stdout.write(`FAIL  ${r.kind.padEnd(8)} not installed\n`);
          } else if (r.action === 'check') {
            process.stdout.write(
              `${r.ok ? 'ok  ' : 'FAIL'}  ${r.kind.padEnd(8)} ${r.authenticated ? 'authenticated' : 'not authenticated'}\n`
            );
          } else {
            const suffix = r.ok ? '' : ` (exit ${r.exitCode ?? '?'})`;
            process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.kind.padEnd(8)} login ${r.ok ? 'ok' : 'failed'}${suffix}\n`);
          }
        }
        if (!allOk) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });
}
