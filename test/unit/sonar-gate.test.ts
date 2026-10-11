import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSonar } from '../../scripts/check-sonar.mjs';

const revision = 'a'.repeat(40);
const config = { repository: 'navaneethbv/flightdeck', revision, pullRequest: '45', token: 'test-token', attempts: 1, intervalMs: 0 };
const clean = { head_sha: revision, app: { slug: 'sonarqubecloud' }, status: 'completed', conclusion: 'success', output: { annotations_count: 0 } };

afterEach(() => { vi.unstubAllGlobals(); });

function api(check = clean, issues: unknown = { total: 0 }, hotspots: unknown = { paging: { total: 0 } }) {
  const fetcher = vi.fn(async (url: URL) => {
    if (url.hostname === 'api.github.com') return Response.json({ check_runs: [check] });
    if (url.pathname === '/api/issues/search') return Response.json(issues);
    return Response.json(hotspots);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('Sonar merge gate', () => {
  it('accepts a completed clean analysis of the requested commit', async () => {
    const fetcher = api();
    await expect(checkSonar(config)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('waits for the latest analysis instead of accepting an earlier successful retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ check_runs: [{ ...clean, status: 'in_progress' }, clean] })));
    await expect(checkSonar(config)).rejects.toThrow('requested commit');
  });

  it('does not accept stale results for a previous commit', async () => {
    api({ ...clean, head_sha: 'b'.repeat(40) });
    await expect(checkSonar(config)).rejects.toThrow('requested commit');
  });

  it('does not accept a skipped analysis', async () => {
    api({ ...clean, conclusion: 'skipped' });
    await expect(checkSonar(config)).rejects.toThrow('concluded skipped');
  });

  it('requires zero annotations even when the Sonar quality gate passes', async () => {
    api({ ...clean, output: { annotations_count: 1 } });
    await expect(checkSonar(config)).rejects.toThrow('new issue annotations');
  });

  it('rejects issues or incomplete API results instead of assuming zero', async () => {
    for (const issues of [{ total: 1 }, {}]) {
      api(clean, issues);
      await expect(checkSonar(config)).rejects.toThrow('unresolved new issues');
    }
  });

  it('rejects unresolved security hotspots', async () => {
    api(clean, { total: 0 }, { paging: { total: 1 } });
    await expect(checkSonar(config)).rejects.toThrow('security hotspots awaiting review');
  });

  it('fails closed when the analysis API is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    await expect(checkSonar(config)).rejects.toThrow('HTTP 503');
  });
});
