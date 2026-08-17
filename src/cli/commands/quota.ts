import { Command } from 'commander';
import { createQuota, getQuota, listQuotas } from '../../argus/quota.js';
import { printJson, handleError, parseSeconds, positiveInteger } from '../util.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerQuota(program: Command): void {
  const quota = program.command('quota').description('Named token budget pools shared across missions and projects');

  quota
    .command('create <id>')
    .description('Create a quota that one or more Argus missions can attach to with --quota')
    .requiredOption('--max-tokens <count>', 'token ceiling for the rolling window')
    .requiredOption('--window <duration>', 'rolling window length, for example 2h')
    .option('--count-cache-reads', 'count cache reads at full weight (default true)', true)
    .option('--no-count-cache-reads', 'do not count cache reads')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const created = createQuota(id, {
          maxTokens: positiveInteger(String(opts.maxTokens), 'max tokens'),
          windowSec: parseSeconds(String(opts.window)),
          countCacheReads: opts.countCacheReads !== false,
        });
        if (opts.json) printJson(created);
        else process.stdout.write(`created quota "${created.id}" (${created.maxTokens} tokens / ${created.windowSec}s)\n`);
      } catch (err) {
        handleError(err);
      }
    });

  quota
    .command('list')
    .description('List every quota')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const quotas = listQuotas();
        if (opts.json) {
          printJson(quotas);
          return;
        }
        for (const q of quotas) {
          process.stdout.write(`${q.id.padEnd(24)} ${q.maxTokens} tokens / ${q.windowSec}s\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  quota
    .command('show <id>')
    .description('Show one quota')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const found = getQuota(id);
        if (!found) throw new Error(`quota "${id}" not found`);
        if (opts.json) {
          printJson(found);
          return;
        }
        process.stdout.write(`${found.id}\n`);
        process.stdout.write(`  max tokens   ${found.maxTokens}\n`);
        process.stdout.write(`  window       ${found.windowSec}s\n`);
        if (found.throttledUntil !== null) {
          process.stdout.write(`  throttled until ${new Date(found.throttledUntil).toISOString()}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
