import { Command } from 'commander';
import { projectRootOf, printJson, handleError, parseSeconds } from '../util.js';
import { ArgusManager } from '../../argus/manager.js';
import { NotesStore } from '../../notes/store.js';
import { renderMissionTemplate, type MissionTemplateKind } from '../../argus/templates.js';

type Opts = Record<string, string | boolean | undefined>;

function printArgusFleet(fleet: ReturnType<ArgusManager['fleet']>): void {
  process.stdout.write(`argus ${fleet.argus.name} (${fleet.argus.id}) ${fleet.argus.status}\n`);
  process.stdout.write(`  mission: ${fleet.argus.missionNoteId}  children: ${fleet.children.length}/${fleet.argus.childLimit}  pulse: ${fleet.argus.pulseSec}s\n`);
  for (const child of fleet.children) {
    const s = child.session;
    const childDesc = s ? `${s.name} ${s.status} ${s.harness}` : 'unknown';
    process.stdout.write(`  child ${childDesc}\n`);
  }
  for (const p of fleet.recentProgress.slice(-5)) {
    const detail = typeof p.detail === 'string' ? p.detail : '';
    process.stdout.write(`  progress: ${String(p.event)} ${detail}\n`);
  }
}

function printArgusList(list: ReturnType<ArgusManager['list']>): void {
  for (const a of list) {
    process.stdout.write(`${a.status.padEnd(8)} ${a.name.padEnd(20)} ${a.id}  children=${a.childLimit} mission=${a.missionNoteId ?? '-'}\n`);
  }
}

export function registerArgus(program: Command): void {
  const argus = program.command('argus').description('Multi-agent orchestrator driven by a mission note');

  argus
    .command('init')
    .description('Initialize a new Mission note using a template')
    .argument('<name>', 'mission name')
    .option('--template <feature|refactor|audit|bugfix>', 'mission template kind', 'feature')
    .option('--title <title>', 'mission title')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const title = opts.title ? String(opts.title) : name;
        const template = (opts.template as MissionTemplateKind) ?? 'feature';
        const body = renderMissionTemplate(template, title);
        const note = new NotesStore(projectRoot).createNote(`${name}-mission`, body);
        if (opts.json) {
          printJson({ note, template, name });
          return;
        }
        process.stdout.write(`created mission note "${note.title}" (${note.id}) using ${template} template\n`);
        process.stdout.write(`start fleet with: deck argus start --name ${name} --mission ${note.id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('start')
    .description('Start an Argus fleet manager (foreground loop)')
    .option('--name <name>', 'fleet name')
    .option('--mission <note-id>', 'existing mission note id')
    .option('--mission-body <text>', 'mission text (creates a note)')
    .option('--pulse <duration>', 'pulse interval, e.g. 30s, 5m, 1h (default 60s)')
    .option('--children <2|4|8|16>', 'max child sessions (default 8)')
    .option('--risky-tools', 'allow children to run playbooks, SSH, and remote execution')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (opts: Opts) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        let missionNoteId: string | undefined;
        if (opts.mission) {
          missionNoteId = String(opts.mission);
          if (!new NotesStore(projectRoot).readNote(missionNoteId)) throw new Error(`mission note "${missionNoteId}" not found`);
        } else if (opts.missionBody) {
          const name = opts.name ? String(opts.name) : 'argus';
          missionNoteId = new NotesStore(projectRoot).createNote(`${name}-mission`, String(opts.missionBody)).id;
        } else {
          throw new Error('argus start requires --mission <note-id> or --mission-body <text>');
        }
        const manager = new ArgusManager(projectRoot);
        const argus = manager.start({
          name: opts.name !== undefined ? String(opts.name) : undefined,
          missionNoteId,
          pulseSec: opts.pulse !== undefined ? parseSeconds(String(opts.pulse)) : undefined,
          childLimit: opts.children !== undefined ? Number(opts.children) : undefined,
          riskyTools: opts.riskyTools === true,
        });
        if (opts.json) printJson({ argus, message: 'running in foreground; press Ctrl+C to stop' });
        else process.stdout.write(`argus ${argus.name} (${argus.id}) running; mission note ${missionNoteId}\n`);
        await manager.runForever(argus.id);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('stop')
    .description('Stop an Argus fleet and its child sessions')
    .argument('<id>', 'argus id')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (id: string, opts: Opts) => {
      try {
        await new ArgusManager(projectRootOf(opts.project as string | undefined)).stop(id);
        process.stdout.write(`stopped argus ${id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('status')
    .description('Show Argus fleets (optionally one fleet with children)')
    .argument('[id]', 'argus id')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string | undefined, opts: Opts) => {
      try {
        const manager = new ArgusManager(projectRootOf(opts.project as string | undefined));
        if (id) {
          const fleet = manager.fleet(id);
          if (opts.json) {
            printJson(fleet);
            return;
          }
          printArgusFleet(fleet);
        } else {
          const list = manager.list();
          if (opts.json) {
            printJson(list);
            return;
          }
          printArgusList(list);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
