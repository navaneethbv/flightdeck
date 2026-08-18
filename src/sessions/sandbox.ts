import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { log } from '../core/logger.js';

/**
 * Wraps a headless harness spawn in macOS's Seatbelt sandbox so the
 * harness's own native file tools (bash, edit) cannot write outside an
 * explicit allowlist, regardless of where the agent decides to navigate.
 *
 * This exists because deck's own isolation (MCP session tokens, tool risk
 * policy) only gates deck's MCP tool surface. It does nothing to stop the
 * underlying coding-agent CLI's native tools, which run as an ordinary OS
 * process with the full reach of the user account. An Argus worker or brain
 * call that gets confused (a missing expected tool, a stray absolute path
 * in its own MCP config) can otherwise wander into and modify any other
 * project on the machine.
 *
 * Reads and network stay unrestricted, mirroring Codex's own
 * `--sandbox workspace-write` (the same Seatbelt primitive, already applied
 * to Codex worker/revision spawns via `autonomy`): restricting only writes
 * keeps provider auth and API calls working without needing to reason about
 * a network allowlist.
 *
 * No equivalent is wired up for Linux yet (Landlock could provide one, but
 * it hasn't been built or tested here); the spawn runs unsandboxed there.
 */
export function wrapForWriteSandbox(
  binary: string,
  args: string[],
  writableRoots: string[]
): { binary: string; args: string[] } {
  if (process.platform !== 'darwin') return { binary, args };

  const sandboxExec = which('sandbox-exec');
  if (!sandboxExec) {
    warnOnce('sandbox-exec not found on PATH; this headless session runs without a write sandbox');
    return { binary, args };
  }

  const roots = new Set<string>();
  for (const root of writableRoots) {
    if (!root) continue;
    roots.add(root);
    const resolved = realpathIfExists(root);
    if (resolved) roots.add(resolved);
  }
  if (roots.size === 0) {
    warnOnce('no writable roots computed for a headless session; skipping the write sandbox');
    return { binary, args };
  }

  const profile = buildProfile([...roots]);
  return { binary: sandboxExec, args: ['-p', profile, binary, ...args] };
}

function buildProfile(writableRoots: string[]): string {
  const allowSubpaths = writableRoots.map((p) => `(subpath ${sbplString(p)})`).join('\n    ');
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write*
    ${allowSubpaths}
)
(allow file-write-data
    (literal "/dev/null")
    (literal "/dev/stdout")
    (literal "/dev/stderr")
)
(allow file-write*
    (regex #"^/dev/tty")
)
`;
}

/** Escapes a path for embedding as an SBPL string literal. */
function sbplString(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function realpathIfExists(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function which(bin: string): string | null {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf8' }).trim(); // NOSONAR: S4036
    return out || null;
  } catch {
    return null;
  }
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  log.warn(message);
}
