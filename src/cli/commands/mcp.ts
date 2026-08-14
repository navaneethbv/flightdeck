import { Command } from 'commander';
import { serveMcp } from '../../mcp/server.js';
import { handleError } from '../util.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerMcp(program: Command): void {
  const mcp = program.command('mcp').description('MCP server');
  mcp
    .command('serve')
    .description('Run the MCP server on stdio for a session')
    .requiredOption('--session <id>', 'session id')
    .requiredOption('--token <token>', 'session token')
    .requiredOption('--project <path>', 'project root')
    .action(async (opts: Opts) => {
      try {
        await serveMcp({
          projectRoot: String(opts.project),
          sessionId: String(opts.session),
          token: String(opts.token),
        });
      } catch (err) {
        handleError(err);
      }
    });
}
