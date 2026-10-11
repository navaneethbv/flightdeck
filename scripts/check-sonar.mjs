import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

async function readJson(url, token) {
  if (url.origin !== 'https://api.github.com' && url.origin !== 'https://sonarcloud.io') throw new Error('Unexpected analysis API origin');
  if (token && url.origin !== 'https://api.github.com') throw new Error('GitHub credentials must only be sent to GitHub');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Analysis API returned HTTP ${response.status}`);
  return response.json();
}

export async function checkSonar({ repository, revision, pullRequest, token, attempts = 40, intervalMs = 15_000 }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(revision) || !/^\d+$/.test(pullRequest)) {
    throw new Error('A repository, full commit SHA, and pull request number are required');
  }
  const checksUrl = new URL('https://api.github.com');
  checksUrl.pathname = `/repos/${repository}/commits/${revision}/check-runs`;
  checksUrl.searchParams.set('check_name', 'SonarCloud Code Analysis');
  let analysis;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const checks = await readJson(checksUrl, token);
    analysis = checks.check_runs?.find((check) => check.head_sha === revision && check.app?.slug === 'sonarqubecloud');
    if (analysis?.status === 'completed') break;
    await setTimeout(intervalMs);
  }
  if (analysis?.status !== 'completed') throw new Error('Sonar did not finish analyzing the requested commit before the deadline');
  if (analysis.conclusion !== 'success') throw new Error(`Sonar analysis concluded ${analysis.conclusion}`);
  if (analysis.output?.annotations_count !== 0) throw new Error('Sonar reported new issue annotations');

  const project = repository.replace('/', '_');
  const issuesUrl = new URL('https://sonarcloud.io/api/issues/search');
  issuesUrl.search = new URLSearchParams({ componentKeys: project, pullRequest, resolved: 'false', ps: '1' }).toString();
  const hotspotsUrl = new URL('https://sonarcloud.io/api/hotspots/search');
  hotspotsUrl.search = new URLSearchParams({ projectKey: project, pullRequest, status: 'TO_REVIEW', ps: '1' }).toString();
  const [issues, hotspots] = await Promise.all([readJson(issuesUrl), readJson(hotspotsUrl)]);
  if (issues.total !== 0) throw new Error(`Sonar has ${issues.total ?? 'unknown'} unresolved new issues`);
  if (hotspots.paging?.total !== 0) throw new Error(`Sonar has ${hotspots.paging?.total ?? 'unknown'} security hotspots awaiting review`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkSonar({ repository: process.env.GITHUB_REPOSITORY, revision: process.env.PR_HEAD_SHA, pullRequest: process.env.PR_NUMBER, token: process.env.GH_TOKEN });
    console.log('Sonar: zero new issues and no security hotspots awaiting review.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Sonar verification failed');
    process.exitCode = 1;
  }
}
