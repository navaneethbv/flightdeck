#!/usr/bin/env node
import { Command } from 'commander';
import { registerSession, registerWorktree } from './commands/session.js';
import { registerNotes, registerTables, registerMessages } from './commands/store.js';
import { registerPlaybooks, registerIntegrations, registerSsh } from './commands/tools.js';
import { registerArgus } from './commands/argus.js';
import { registerMcp } from './commands/mcp.js';
import { registerConfig } from './commands/config.js';
import { registerDoctor } from './commands/doctor.js';
import { registerWatchdog } from './commands/watchdog.js';
import { registerTui } from './commands/tui.js';
import { registerUi } from './commands/ui.js';

const program = new Command();

program
  .name('deck')
  .description('Agents Control: CLI control-plane for coding agents')
  .version('0.1.0');

registerSession(program);
registerWorktree(program);
registerNotes(program);
registerTables(program);
registerMessages(program);
registerPlaybooks(program);
registerIntegrations(program);
registerSsh(program);
registerArgus(program);
registerMcp(program);
registerConfig(program);
registerDoctor(program);
registerWatchdog(program);
registerTui(program);
registerUi(program);

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
