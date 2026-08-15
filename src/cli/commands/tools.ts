import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { projectRootOf, printJson, handleError } from '../util.js';
import { parsePlaybookYaml } from '../../playbooks/parser.js';
import type { Playbook } from '../../playbooks/types.js';
import { PlaybookEngine, type EngineServices } from '../../playbooks/engine.js';
import { NotesStore } from '../../notes/store.js';
import { TablesStore } from '../../tables/store.js';
import { MessagingStore } from '../../messaging/store.js';
import { ToolRegistry, type McpContext } from '../../mcp/tools.js';
import { Integrations } from '../../integrations/index.js';
import { SshStore } from '../../ssh/hosts.js';
import { playbooksDir, globalPlaybooksDir } from '../../core/paths.js';
import type { Session } from '../../core/types.js';
import { getDefaultHarness } from '../../core/config.js';
import { getAdapter } from '../../sessions/harness.js';
import { BUILTIN_PLAYBOOKS } from '../../playbooks/templates.js';

type Opts = Record<string, string | boolean | undefined>;

function promptConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}

function buildEngine(projectRoot: string): { engine: PlaybookEngine; registry: ToolRegistry } {
  const ctx: McpContext = {
    projectRoot,
    sessionId: null,
    policy: 'default',
    isManager: false,
    riskyTools: false,
    confirm: promptConfirm,
  };
  const registry = new ToolRegistry(ctx);
  const services: EngineServices = {
    projectRoot,
    tables: new TablesStore(projectRoot),
    notes: new NotesStore(projectRoot),
    messaging: new MessagingStore(projectRoot),
    callMcpTool: async (tool, args) => registry.call(tool, args),
    runHeadlessPrompt: async (prompt) => {
      const harness = getAdapter(getDefaultHarness());
      const out = spawnSync(harness.binary, harness.headlessArgs(prompt, {}), {
        cwd: projectRoot,
        env: { ...process.env, ...harness.profileEnv({} as Session) },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 20 * 1024 * 1024,
      });
      return { stdout: out.stdout ?? out.stderr ?? '', exitCode: out.status ?? -1 };
    },
    readPlaybook: (name) => {
      for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
        const file = path.join(dir, `${name}.yml`);
        if (fs.existsSync(file)) return parsePlaybookYaml(fs.readFileSync(file, 'utf8'), name);
      }
      if (name in BUILTIN_PLAYBOOKS) {
        return parsePlaybookYaml(BUILTIN_PLAYBOOKS[name], name);
      }
      return null;
    },
    confirm: promptConfirm,
  };
  return { engine: new PlaybookEngine(services), registry };
}

export function registerPlaybooks(program: Command): void {
  const playbooks = program.command('playbook').description('Reusable workflow playbooks');

  playbooks
    .command('list')
    .description('List playbooks')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const names = new Set<string>(Object.keys(BUILTIN_PLAYBOOKS));
        for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
          try {
            for (const file of fs.readdirSync(dir)) {
              if (file.endsWith('.yml')) names.add(file.slice(0, -4));
            }
          } catch {
            // missing dir
          }
        }
        const list = [...names].sort((a, b) => a.localeCompare(b));
        if (opts.json) printJson(list);
        else for (const n of list) process.stdout.write(`${n}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  playbooks
    .command('run')
    .description('Run a playbook')
    .argument('<name>', 'playbook name')
    .option('--input <json>', 'input values as JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (name: string, opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const { engine } = buildEngine(projectRoot);
        const playbook = findPlaybook(name, projectRoot);
        const result = await engine.run(playbook, {
          inputs: opts.input !== undefined ? (JSON.parse(String(opts.input)) as Record<string, unknown>) : undefined,
          onProgress: (id, stepResult) => {
            if (opts.json) return;
            process.stderr.write(`  ${stepResult.status === 'ok' ? 'ok' : 'FAIL'}  ${id}\n`);
          },
        });
        if (opts.json) printJson(result);
        else printPlaybookResult(name, result);
        if (!result.ok) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  playbooks
    .command('save')
    .description('Save a playbook from a YAML file')
    .argument('<name>', 'playbook name')
    .argument('<file>', 'path to YAML file')
    .option('--project <path>', 'project root (default: current directory)')
    .action((name: string, file: string, opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const content = fs.readFileSync(file, 'utf8');
        parsePlaybookYaml(content, name);
        const dir = playbooksDir(projectRoot);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${name}.yml`), content);
        process.stdout.write(`saved playbook ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

type IntegrationKind = 'jira' | 'github' | 'slack';

export function registerIntegrations(program: Command): void {
  const integrations = program.command('integration').description('Jira / GitHub / Slack integrations');

  integrations
    .command('auth')
    .description('Configure an integration')
    .argument('<kind>', 'jira | github | slack')
    .option('--domain <domain>', 'Jira domain (jira only)')
    .option('--email <email>', 'Jira email (jira only)')
    .option('--token <token>', 'API token (prompts if omitted)')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (kind: string, opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        if (kind !== 'jira' && kind !== 'github' && kind !== 'slack') throw new Error(`unknown integration "${kind}"`);
        let token = opts.token !== undefined ? String(opts.token) : undefined;
        token ??= await new Promise<string>((resolve) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          rl.question(`${kind} API token: `, (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
        await new Integrations(projectRoot).auth(kind, {
          domain: opts.domain !== undefined ? String(opts.domain) : undefined,
          email: opts.email !== undefined ? String(opts.email) : undefined,
          token,
        });
        process.stdout.write(`${kind} configured and cache refreshed\n`);
      } catch (err) {
        handleError(err);
      }
    });

  integrations
    .command('refresh')
    .description('Force-refresh integration cache')
    .argument('<kind>', 'jira | github | slack')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (kind: string, opts: Opts) => {
      try {
        await new Integrations(projectRootOf(opts.project as string | undefined)).refresh(kind as IntegrationKind);
        process.stdout.write(`refreshed ${kind}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  integrations
    .command('status')
    .description('Show configured integrations')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const configured = new Integrations(projectRootOf(opts.project as string | undefined)).configuredKinds();
        if (opts.json) printJson(configured);
        else process.stdout.write(configured.length ? `configured: ${configured.join(', ')}\n` : 'none configured\n');
      } catch (err) {
        handleError(err);
      }
    });

  integrations
    .command('sync')
    .description('Sync integration records into a structured project table')
    .argument('<kind>', 'jira | github | slack')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (kind: string, opts: Opts) => {
      try {
        const result = await new Integrations(projectRootOf(opts.project as string | undefined)).syncToTable(
          kind as 'jira' | 'github' | 'slack'
        );
        if (opts.json) printJson(result);
        else process.stdout.write(`synced ${result.count} items into table ${result.table}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  integrations
    .command('deauth')
    .description('Remove integration credentials')
    .argument('<kind>', 'jira | github | slack')
    .option('--project <path>', 'project root (default: current directory)')
    .action((kind: string, opts: Opts) => {
      try {
        new Integrations(projectRootOf(opts.project as string | undefined)).deauth(kind as 'jira' | 'github' | 'slack');
        process.stdout.write(`removed ${kind} credentials\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

export function registerSsh(program: Command): void {
  const ssh = program.command('ssh').description('Saved SSH hosts and remote commands');

  ssh
    .command('add')
    .description('Add a saved host')
    .argument('<name>', 'host name')
    .argument('<host>', 'hostname or address')
    .option('-p, --port <n>', 'port')
    .option('-u, --user <user>', 'username')
    .option('--auth <agent|key|password>', 'auth method', 'agent')
    .option('--key-file <path>', 'key file (auth=key)')
    .option('--project <path>', 'project root (default: current directory)')
    .action((name: string, host: string, opts: Opts) => {
      try {
        new SshStore(projectRootOf(opts.project as string | undefined)).add({
          name,
          host,
          port: opts.port !== undefined ? Number(opts.port) : null,
          user: opts.user !== undefined ? String(opts.user) : null,
          auth: (opts.auth as 'agent' | 'key' | 'password') ?? 'agent',
          keyFile: opts.keyFile !== undefined ? String(opts.keyFile) : null,
          createdAt: 0,
        });
        process.stdout.write(`added host ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  ssh
    .command('list')
    .description('List saved hosts')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const list = new SshStore(projectRootOf(opts.project as string | undefined)).list();
        if (opts.json) printJson(list);
        else {
          for (const h of list) {
            const userPrefix = h.user ? `${h.user}@` : '';
            process.stdout.write(`${h.name.padEnd(20)} ${userPrefix}${h.host}:${h.port ?? 22} [${h.auth}]\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  ssh
    .command('remove')
    .description('Remove a saved host')
    .argument('<name>', 'host name')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        new SshStore(projectRootOf(opts.project as string | undefined)).remove(name);
        if (opts.json) printJson({ removed: name });
        else process.stdout.write(`removed host ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  ssh
    .command('run')
    .description('Run a command on a saved host')
    .argument('<name>', 'host name')
    .argument('<command>', 'command to run')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (name: string, command: string, opts: Opts) => {
      try {
        const store = new SshStore(projectRootOf(opts.project as string | undefined));
        const host = store.get(name);
        if (!host) throw new Error(`host "${name}" not found`);
        const result = await store.run(host, command);
        process.stdout.write(result.stdout + (result.stdout.endsWith('\n') ? '' : '\n'));
        if (result.exitCode !== 0) process.exitCode = result.exitCode;
      } catch (err) {
        handleError(err);
      }
    });
}

function findPlaybook(name: string, projectRoot: string): Playbook {
  for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
    const file = path.join(dir, `${name}.yml`);
    if (fs.existsSync(file)) return parsePlaybookYaml(fs.readFileSync(file, 'utf8'), name);
  }
  if (name in BUILTIN_PLAYBOOKS) {
    return parsePlaybookYaml(BUILTIN_PLAYBOOKS[name], name);
  }
  throw new Error(`playbook "${name}" not found`);
}

function printPlaybookResult(name: string, result: { ok: boolean; results: Record<string, { status: string; error?: string }> }): void {
  for (const [id, stepResult] of Object.entries(result.results)) {
    const errSuffix = stepResult.error ? `  ${stepResult.error}` : '';
    process.stdout.write(`[${stepResult.status.toUpperCase()}] ${id}${errSuffix}\n`);
  }
  process.stdout.write(`playbook "${name}" ${result.ok ? 'succeeded' : 'failed'}\n`);
}
