import { execFileSync } from 'node:child_process';

function reap(): void {
  for (const pattern of ['flightdeck-repo-', 'flightdeck-bin-', 'flightdeck-test-home-']) {
    try {
      execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' }); // NOSONAR: S4036
    } catch {
      // pkill exits non-zero when nothing matched, which is the good case.
    }
  }
}

/**
 * Last line of defence. Even with the spawn guard, a crashed test can leave a
 * stub process behind, and a stub that hangs is still a leaked process. This
 * kills anything whose argv points at a fixture directory from this run.
 */
export default function setup(): () => void {
  return () => {
    reap();
  };
}

export function teardown(): void {
  reap();
}
