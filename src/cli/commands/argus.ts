import { Command } from 'commander';
import { projectRootOf, printJson, handleError, parseSeconds } from '../util.js';
import { ArgusManager } from '../../argus/manager.js';
import { NotesStore } from '../../notes/store.js';
import { renderMissionTemplate, type MissionTemplateKind } from '../../argus/templates.js';
import { TaskBoard } from '../../argus/board.js';
import { budgetState } from '../../argus/budget.js';
import type { BrainHarness, WorkerHarness } from '../../core/types.js';

type Opts = Record<string, string | boolean | undefined>;

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function brainHarness(value: string): BrainHarness {
  if (value !== 'claude' && value !== 'codex') {
    throw new Error(`brain harness must be claude or codex (got ${value})`);
  }
  return value;
}

function workerHarnesses(values: string[]): WorkerHarness[] | undefined {
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (value !== 'opencode' && value !== 'gemini') {
      throw new Error(`worker harness must be opencode or gemini (got ${value})`);
    }
  }
  return values as WorkerHarness[];
}

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
    .option('--brain-harness <claude|codex>', 'reasoning brain harness', 'claude')
    .option('--brain-plan-model <model>', 'model for planning and tier 2 review')
    .option('--brain-review-model <model>', 'model for tier 1 review and answers')
    .option(
      '--worker-harness <opencode|gemini>',
      'worker harness, repeat for round-robin workers',
      (value: string, prior: string[]) => [...prior, value],
      []
    )
    .option('--budget-window <duration>', 'rolling brain budget window, for example 2h')
    .option('--budget-max-tokens <count>', 'maximum brain tokens in the window')
    .option('--max-attempts <count>', 'attempt limit per task')
    .option('--max-tasks <count>', 'task count ceiling for the mission')
    .option('--question-timeout <duration>', 'worker question timeout')
    .option('--conventions <note-id>', 'project conventions note id')
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
          brainHarness: opts.brainHarness !== undefined ? brainHarness(String(opts.brainHarness)) : undefined,
          brainPlanModel: opts.brainPlanModel !== undefined ? String(opts.brainPlanModel) : undefined,
          brainReviewModel: opts.brainReviewModel !== undefined ? String(opts.brainReviewModel) : undefined,
          workerHarnesses: workerHarnesses((opts.workerHarness as string[] | undefined) ?? []),
          budgetWindowSec: opts.budgetWindow !== undefined ? parseSeconds(String(opts.budgetWindow)) : undefined,
          budgetMaxTokens: opts.budgetMaxTokens !== undefined ? positiveInteger(String(opts.budgetMaxTokens), 'budget maximum') : undefined,
          maxAttemptsPerTask: opts.maxAttempts !== undefined ? positiveInteger(String(opts.maxAttempts), 'maximum attempts') : undefined,
          maxTasks: opts.maxTasks !== undefined ? positiveInteger(String(opts.maxTasks), 'maximum tasks') : undefined,
          questionTimeoutSec: opts.questionTimeout !== undefined ? parseSeconds(String(opts.questionTimeout)) : undefined,
          conventionsNoteId: opts.conventions !== undefined ? String(opts.conventions) : undefined,
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

  argus
    .command('board <id>')
    .description('Show the task board for a fleet')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const tasks = new TaskBoard(projectRoot).list(id);
        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }
        if (tasks.length === 0) {
          console.log('(no tasks)');
          return;
        }
        for (const task of tasks) {
          const attempts = task.attempts > 0 ? ` attempts=${task.attempts}` : '';
          console.log(`${task.status.padEnd(10)} ${task.id.slice(0, 8)}  ${task.title}${attempts}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('budget <id>')
    .description('Show brain token spend for the current window')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const state = budgetState(projectRoot, id);
        if (opts.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        const pct = (state.fraction * 100).toFixed(1);
        console.log(`spent   ${state.spent} / ${state.ceiling} tokens (${pct}%)`);
        console.log(`tier    ${state.tier}`);
        console.log(`reviews ${state.policy.reviewsAllowed ? 'draining' : 'paused'}`);
        console.log(`tier 2  ${state.policy.tier2Allowed ? 'allowed' : 'disabled'}`);
        console.log(`queued  ${state.reviewQueueDepth}`);
        if (state.nextResetAt !== null) {
          console.log(`next reset ${new Date(state.nextResetAt).toISOString()}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('task <taskId>')
    .description('Show one task in full, including the worker report and gate output')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((taskId: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const task = new TaskBoard(projectRoot).get(taskId);
        if (!task) throw new Error(`task "${taskId}" not found`);
        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        console.log(`${task.title}  [${task.status}]`);
        console.log(`\nSpec:\n${task.spec}`);
        if (task.workerReport) {
          console.log(`\nWorker summary:\n${task.workerReport.summary}`);
          console.log(`Uncertainties: ${task.workerReport.uncertainties || '(none)'}`);
        }
        if (task.gateResult) {
          console.log(
            `\nGates: test=${task.gateResult.testExitCode ?? 'skipped'} lint=${task.gateResult.lintExitCode ?? 'skipped'}`
          );
          if (task.gateResult.failureTail) console.log(task.gateResult.failureTail);
        }
        if (task.verdictReason) console.log(`\nFeedback:\n${task.verdictReason}`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('plan <id>')
    .description('Ask the brain to plan the mission into board tasks (costs brain tokens)')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new ArgusManager(projectRoot).plan(id);
        const tasks = new TaskBoard(projectRoot).list(id);
        console.log(`planned ${tasks.length} tasks`);
      } catch (err) {
        handleError(err);
      }
    });
}
