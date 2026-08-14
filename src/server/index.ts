import http, { IncomingMessage, ServerResponse, Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjectRoot, playbooksDir, globalPlaybooksDir } from '../core/paths.js';
import { SessionManager } from '../sessions/manager.js';
import { ArgusManager } from '../argus/manager.js';
import { NotesStore } from '../notes/store.js';
import { TablesStore } from '../tables/store.js';
import { MessagingStore } from '../messaging/store.js';
import { WatchdogManager } from '../watchdog/manager.js';
import { listWorktrees } from '../worktrees/manager.js';
import { BUILTIN_PLAYBOOKS } from '../playbooks/templates.js';
import { parsePlaybookYaml } from '../playbooks/parser.js';
import { PlaybookEngine, type EngineServices } from '../playbooks/engine.js';
import { ToolRegistry, type McpContext } from '../mcp/tools.js';
import { isHarnessKind } from '../core/types.js';
import { getDefaultHarness } from '../core/config.js';
import { getAdapter } from '../sessions/harness.js';
import { spawnSync } from 'node:child_process';
import type { Session } from '../core/types.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface WebServerOptions {
  port?: number;
  projectRoot?: string;
  staticDir?: string;
}

export function createWebServer(opts: WebServerOptions = {}): {
  server: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const projectRoot = normalizeProjectRoot(opts.projectRoot ?? process.cwd());
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, '..', 'web', 'public');
  const srcDir = path.resolve(here, '..', '..', 'src', 'web', 'public');
  const staticDir: string =
    opts.staticDir ?? (fs.existsSync(distDir) ? distDir : fs.existsSync(srcDir) ? srcDir : path.resolve(process.cwd(), 'src', 'web', 'public'));

  const sseClients = new Set<ServerResponse>();

  function broadcastUpdate(): void {
    const data = JSON.stringify({ type: 'update', timestamp: Date.now() });
    for (const client of sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function getState(): Record<string, unknown> {
    const sm = new SessionManager(projectRoot);
    const argusManager = new ArgusManager(projectRoot);
    const notesStore = new NotesStore(projectRoot);
    const tablesStore = new TablesStore(projectRoot);
    const messaging = new MessagingStore(projectRoot);
    const watchdog = new WatchdogManager(projectRoot);

    const argusList = argusManager.list();
    const fleets: Record<string, unknown>[] = [];
    for (const a of argusList) {
      const f = argusManager.fleet(a.id);
      fleets.push({
        ...a,
        children: f.children.map((c) => ({
          ...c,
          session: c.session,
        })),
        recentProgress: f.recentProgress,
      });
    }

    let worktrees: ReturnType<typeof listWorktrees> = [];
    try {
      worktrees = listWorktrees(projectRoot);
    } catch {
      // not a git repo
    }

    const playbookNames = new Set<string>(Object.keys(BUILTIN_PLAYBOOKS));
    for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
      try {
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.yml')) playbookNames.add(f.slice(0, -4));
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      projectRoot,
      projectName: path.basename(projectRoot),
      sessions: sm.list(),
      argus: fleets,
      notes: notesStore.list(),
      tables: tablesStore.listTables(),
      messages: messaging.list({ limit: 30 }),
      watchdog: {
        hungSessions: watchdog.listHung(300),
      },
      worktrees,
      playbooks: [...playbookNames].sort(),
      defaultHarness: getDefaultHarness(),
    };
  }

  async function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res: ServerResponse, status: number, data: unknown): void {
    const json = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(json);
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { error: message });
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url === '/' || !req.url ? '/index.html' : req.url.split('?')[0];
    const safePath = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(staticDir, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } else {
      const indexFallback = path.join(staticDir, 'index.html');
      if (fs.existsSync(indexFallback)) {
        const content = fs.readFileSync(indexFallback);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': content.length,
        });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
    }
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const [pathname] = url.split('?');

    // 1. SSE Events Stream
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 2. Full State API
    if (pathname === '/api/state' && req.method === 'GET') {
      try {
        sendJson(res, 200, getState());
      } catch (err) {
        sendError(res, 500, (err as Error).message);
      }
      return;
    }

    // 3. Sessions APIs
    if (pathname === '/api/sessions/start' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const sm = new SessionManager(projectRoot);
        const harness = (body.harness as string) ?? getDefaultHarness();
        if (!isHarnessKind(harness)) throw new Error(`unknown harness "${harness}"`);
        const session = sm.createSession({
          name: (body.name as string) ?? 'session',
          harness,
          worktree: (body.worktree as string) ?? null,
          cwd: projectRoot,
          task: (body.task as string) ?? null,
        });
        const started = await sm.startSession(session.id, {
          headless: body.headless === true,
          prompt: (body.prompt as string) ?? undefined,
          waitForExit: false,
        });
        broadcastUpdate();
        sendJson(res, 200, started);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/stop') && req.method === 'POST') {
      try {
        const id = pathname.slice('/api/sessions/'.length, -'/stop'.length);
        const sm = new SessionManager(projectRoot);
        await sm.stopSession(id);
        broadcastUpdate();
        sendJson(res, 200, { stopped: true, id });
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/logs') && req.method === 'GET') {
      try {
        const id = pathname.slice('/api/sessions/'.length, -'/logs'.length);
        const sm = new SessionManager(projectRoot);
        const logs = sm.getLogs(id, 300);
        sendJson(res, 200, { id, logs });
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    // 4. Argus Mission & Fleets APIs
    if (pathname === '/api/argus/start' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const am = new ArgusManager(projectRoot);
        const fleet = am.start({
          name: (body.name as string) ?? 'argus',
          missionNoteId: (body.missionNoteId as string) ?? undefined,
          pulseSec: body.pulseSec !== undefined ? Number(body.pulseSec) : undefined,
          childLimit: body.childLimit !== undefined ? Number(body.childLimit) : undefined,
          riskyTools: body.riskyTools === true,
        });
        broadcastUpdate();
        sendJson(res, 200, fleet);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname === '/api/argus/pulse' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const id = String(body.id);
        const am = new ArgusManager(projectRoot);
        const progress = await am.pulse(id);
        broadcastUpdate();
        sendJson(res, 200, { id, progress });
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname.startsWith('/api/argus/') && pathname.endsWith('/stop') && req.method === 'POST') {
      try {
        const id = pathname.slice('/api/argus/'.length, -'/stop'.length);
        const am = new ArgusManager(projectRoot);
        await am.stop(id);
        broadcastUpdate();
        sendJson(res, 200, { stopped: true, id });
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    // 5. Notes APIs
    if (pathname === '/api/notes/create' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const ns = new NotesStore(projectRoot);
        const note = ns.createNote(String(body.title), String(body.body ?? ''));
        broadcastUpdate();
        sendJson(res, 200, note);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname === '/api/notes/update' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const ns = new NotesStore(projectRoot);
        const note = ns.updateNote(String(body.id), {
          title: body.title !== undefined ? String(body.title) : undefined,
          body: body.body !== undefined ? String(body.body) : undefined,
        });
        broadcastUpdate();
        sendJson(res, 200, note);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    // 6. Messages API (Reply now)
    if (pathname === '/api/messages/send' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const ms = new MessagingStore(projectRoot);
        const fromSession = (body.fromSession as string) ?? 'user';
        const toSession = (body.toSession as string) ?? null;
        const msg = ms.send(fromSession, toSession, String(body.body));
        broadcastUpdate();
        sendJson(res, 200, msg);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    // 7. Toolkit / Playbook Execution
    if (pathname === '/api/toolkit/run' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const name = String(body.action);
        let playbookYaml = BUILTIN_PLAYBOOKS[name];
        if (!playbookYaml) {
          for (const dir of [playbooksDir(projectRoot), globalPlaybooksDir]) {
            const file = path.join(dir, `${name}.yml`);
            if (fs.existsSync(file)) {
              playbookYaml = fs.readFileSync(file, 'utf8');
              break;
            }
          }
        }
        if (!playbookYaml) throw new Error(`playbook "${name}" not found`);

        const playbook = parsePlaybookYaml(playbookYaml, name);
        const ctx: McpContext = {
          projectRoot,
          sessionId: null,
          policy: 'default',
          isManager: true,
          riskyTools: true,
          confirm: async () => true,
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
            });
            return { stdout: out.stdout ?? out.stderr ?? '', exitCode: out.status ?? -1 };
          },
          readPlaybook: (n) =>
            n in BUILTIN_PLAYBOOKS ? parsePlaybookYaml(BUILTIN_PLAYBOOKS[n], n) : null,
          confirm: async () => true,
        };
        const engine = new PlaybookEngine(services);
        const result = await engine.run(playbook, {
          inputs: (body.inputs as Record<string, unknown>) ?? undefined,
        });
        broadcastUpdate();
        sendJson(res, 200, result);
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    // Static Assets fallback
    serveStatic(req, res);
  });

  return {
    server,
    start: () =>
      new Promise<number>((resolve, reject) => {
        const port = opts.port ?? 4173;
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(actualPort);
        });
        server.on('error', reject);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            // ignore
          }
        }
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
}
