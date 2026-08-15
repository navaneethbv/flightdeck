import { Command } from 'commander';
import { exec } from 'node:child_process';
import { projectRootOf, handleError } from '../util.js';
import { createWebServer } from '../../server/index.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerUi(program: Command): void {
  program
    .command('ui')
    .alias('web')
    .description('Launch the Flightdeck Web GUI Dashboard in the browser')
    .option('--port <number>', 'port to listen on', '4173')
    .option('--no-open', 'do not open browser automatically')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const port = parseInt(String(opts.port ?? '4173'), 10) || 4173;

        const webServer = createWebServer({
          port,
          projectRoot,
        });

        const actualPort = await webServer.start();
        // The capability token travels in the URL fragment, which is never sent
        // to the server; the client reads it to authorize every /api/* call.
        const url = `http://127.0.0.1:${actualPort}/#token=${webServer.capabilityToken}`;

        process.stdout.write(`\n⚡ Flightdeck Control Plane Dashboard\n`);
        process.stdout.write(`   Project: ${projectRoot}\n`);
        process.stdout.write(`   URL:     ${url}\n`);
        process.stdout.write(`   Capability token: ${webServer.capabilityToken}\n\n`);
        process.stdout.write(`   Press Ctrl+C to stop the web server.\n\n`);

        if (opts.open !== false) {
          const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
          exec(`${openCmd} ${url}`);
        }

        const cleanup = async (): Promise<void> => {
          process.stdout.write('\nStopping web server...\n');
          await webServer.stop();
          process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
      } catch (err) {
        handleError(err);
      }
    });
}
