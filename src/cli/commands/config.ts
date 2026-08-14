import { Command } from 'commander';
import { loadConfig, setDefaultHarness, setProfileDir } from '../../core/config.js';
import { isHarnessKind } from '../../core/types.js';
import { globalConfigPath } from '../../core/paths.js';
import { printJson, handleError } from '../util.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerConfig(program: Command): void {
  const config = program.command('config').description('Global configuration');

  config
    .command('get')
    .description('Show the global config')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const value = loadConfig();
        if (opts.json) printJson(value);
        else {
          process.stdout.write(`config file: ${globalConfigPath}\n`);
          process.stdout.write(`default harness: ${value.defaultHarness}\n`);
          for (const [k, v] of Object.entries(value.profileDir)) process.stdout.write(`profile dir ${k}: ${v}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  config
    .command('set-default-harness')
    .description('Set the default coding-agent harness')
    .argument('<harness>', 'claude | codex | opencode | gemini')
    .action((harness: string) => {
      try {
        if (!isHarnessKind(harness)) throw new Error(`unknown harness "${harness}"`);
        setDefaultHarness(harness);
        process.stdout.write(`default harness set to ${harness}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  config
    .command('set-profile-dir')
    .description('Set the profile/config directory for a harness')
    .argument('<harness>', 'claude | codex | opencode | gemini')
    .argument('<dir>', 'profile directory path')
    .action((harness: string, dir: string) => {
      try {
        if (!isHarnessKind(harness)) throw new Error(`unknown harness "${harness}"`);
        setProfileDir(harness, dir);
        process.stdout.write(`profile dir for ${harness} set to ${dir}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  config
    .command('path')
    .description('Show the global config path')
    .action(() => {
      process.stdout.write(`${globalConfigPath}\n`);
    });
}
