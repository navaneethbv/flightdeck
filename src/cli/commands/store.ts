import { Command } from 'commander';
import { projectRootOf, printJson, handleError } from '../util.js';
import { NotesStore } from '../../notes/store.js';
import { TablesStore } from '../../tables/store.js';
import { MessagingStore } from '../../messaging/store.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerNotes(program: Command): void {
  const notes = program.command('note').description('Manage project notes');

  notes
    .command('create')
    .description('Create a note')
    .argument('<title>', 'note title')
    .option('-b, --body <text>', 'note body')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((title: string, opts: Opts) => {
      try {
        const note = new NotesStore(projectRootOf(opts.project as string | undefined)).createNote(title, String(opts.body ?? ''));
        if (opts.json) printJson(note);
        else process.stdout.write(`created note ${note.id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  notes
    .command('read')
    .description('Read a note')
    .argument('<id>', 'note id')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const note = new NotesStore(projectRootOf(opts.project as string | undefined)).readNote(id);
        if (!note) throw new Error(`note "${id}" not found`);
        if (opts.json) printJson(note);
        else process.stdout.write(`# ${note.title}\n\n${note.body}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  notes
    .command('list')
    .description('List notes')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const list = new NotesStore(projectRootOf(opts.project as string | undefined)).listNotes();
        if (opts.json) printJson(list);
        else for (const n of list) process.stdout.write(`${n.id.padEnd(28)} v${n.version}  ${n.title}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  notes
    .command('search')
    .description('Full-text search notes')
    .argument('<query>', 'search query')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((query: string, opts: Opts) => {
      try {
        const results = new NotesStore(projectRootOf(opts.project as string | undefined)).searchNotes(query);
        if (opts.json) printJson(results);
        else for (const r of results) process.stdout.write(`${r.id.padEnd(28)}  ${r.title}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  notes
    .command('update')
    .description('Update a note (new version)')
    .argument('<id>', 'note id')
    .option('--title <title>', 'new title')
    .option('-b, --body <text>', 'new body')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const note = new NotesStore(projectRootOf(opts.project as string | undefined)).updateNote(id, {
          title: opts.title !== undefined ? String(opts.title) : undefined,
          body: opts.body !== undefined ? String(opts.body) : undefined,
        });
        if (opts.json) printJson(note);
        else process.stdout.write(`updated note ${note.id} (v${note.version})\n`);
      } catch (err) {
        handleError(err);
      }
    });

  notes
    .command('delete')
    .description('Delete a note')
    .argument('<id>', 'note id')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        new NotesStore(projectRootOf(opts.project as string | undefined)).deleteNote(id);
        if (opts.json) printJson({ deleted: id });
        else process.stdout.write(`deleted note ${id}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

export function registerTables(program: Command): void {
  const tables = program.command('table').description('Manage structured project tables');

  tables
    .command('create')
    .description('Create a typed table')
    .argument('<name>', 'table name')
    .requiredOption('--columns <json>', 'columns as JSON, e.g. [{"name":"title","type":"text"}]')
    .option('--idempotency-key <col>', 'column acting as idempotency key')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const columns = JSON.parse(String(opts.columns)) as { name: string; type: string }[];
        const info = new TablesStore(projectRootOf(opts.project as string | undefined)).createTable(
          name,
          columns.map((c) => ({ name: c.name, type: c.type as never })),
          opts.idempotencyKey !== undefined ? String(opts.idempotencyKey) : undefined
        );
        if (opts.json) printJson(info);
        else process.stdout.write(`created table ${info.name}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('list')
    .description('List tables')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const list = new TablesStore(projectRootOf(opts.project as string | undefined)).listTables();
        if (opts.json) printJson(list);
        else {
          for (const t of list) {
            const cols = t.columns.map((c) => `${c.name}:${c.type}`).join(', ');
            process.stdout.write(`${t.name.padEnd(20)} (${cols})\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('insert')
    .description('Insert a row')
    .argument('<name>', 'table name')
    .requiredOption('--data <json>', 'row data as JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const data = JSON.parse(String(opts.data)) as Record<string, unknown>;
        const result = new TablesStore(projectRootOf(opts.project as string | undefined)).insertRow(name, data);
        if (opts.json) printJson(result);
        else process.stdout.write(`inserted row ${result.rowid}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('query')
    .description('Query rows')
    .argument('<name>', 'table name')
    .option('--where <json>', 'equality filters as JSON')
    .option('--limit <n>', 'max rows')
    .option('--order-by <json>', 'ordering as JSON, e.g. {"col":"title","dir":"desc"}')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const store = new TablesStore(projectRootOf(opts.project as string | undefined));
        const rows = store.query(name, {
          where: opts.where !== undefined ? (JSON.parse(String(opts.where)) as Record<string, unknown>) : undefined,
          limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
          orderBy: opts.orderBy !== undefined ? (JSON.parse(String(opts.orderBy)) as { col: string; dir?: 'asc' | 'desc' }) : undefined,
        });
        if (opts.json) printJson(rows);
        else process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('update')
    .description('Update a row by rowid')
    .argument('<name>', 'table name')
    .requiredOption('--rowid <id>', 'rowid to update')
    .requiredOption('--data <json>', 'updated data as JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const data = JSON.parse(String(opts.data)) as Record<string, unknown>;
        new TablesStore(projectRootOf(opts.project as string | undefined)).updateRow(name, Number(opts.rowid), data);
        if (opts.json) printJson({ updated: true });
        else process.stdout.write(`updated row ${opts.rowid} in table ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('aggregate')
    .description('Aggregate a table column (count/sum/avg/min/max)')
    .argument('<name>', 'table name')
    .requiredOption('--fn <count|sum|avg|min|max>', 'aggregation function')
    .option('--column <col>', 'column to aggregate')
    .option('--group-by <col>', 'group by column')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        const results = new TablesStore(projectRootOf(opts.project as string | undefined)).aggregate(
          name,
          String(opts.fn) as 'count' | 'sum' | 'avg' | 'min' | 'max',
          opts.column !== undefined ? String(opts.column) : undefined,
          opts.groupBy !== undefined ? String(opts.groupBy) : undefined
        );
        if (opts.json) printJson(results);
        else process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      } catch (err) {
        handleError(err);
      }
    });

  tables
    .command('drop')
    .description('Drop a table')
    .argument('<name>', 'table name')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Opts) => {
      try {
        new TablesStore(projectRootOf(opts.project as string | undefined)).dropTable(name);
        if (opts.json) printJson({ dropped: name });
        else process.stdout.write(`dropped table ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

export function registerMessages(program: Command): void {
  const messages = program.command('message').description('Inter-session messages');

  messages
    .command('send')
    .description('Send a message')
    .requiredOption('--to <session-id>', 'recipient session id')
    .argument('<body>', 'message body')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((body: string, opts: Opts) => {
      try {
        const msg = new MessagingStore(projectRootOf(opts.project as string | undefined)).send('cli', String(opts.to), body);
        if (opts.json) printJson(msg);
        else process.stdout.write(`sent message ${msg.id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  messages
    .command('list')
    .description('List messages')
    .option('--to <session-id>', 'filter by recipient')
    .option('--limit <n>', 'max messages')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const list = new MessagingStore(projectRootOf(opts.project as string | undefined)).list({
          to: opts.to !== undefined ? String(opts.to) : undefined,
          limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
        });
        if (opts.json) printJson(list);
        else for (const m of list) process.stdout.write(`[${m.id}] ${m.fromSession} -> ${m.toSession ?? '*'}  ${m.body}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  messages
    .command('poll')
    .description('Poll for unread messages since a message id')
    .requiredOption('--to <session-id>', 'recipient session id')
    .option('--since-id <id>', 'message id to poll after', '0')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const polled = new MessagingStore(projectRootOf(opts.project as string | undefined)).poll(
          String(opts.to),
          Number(opts.sinceId ?? 0)
        );
        if (opts.json) printJson(polled);
        else for (const m of polled) process.stdout.write(`[${m.id}] ${m.fromSession} -> ${m.toSession}  ${m.body}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}
