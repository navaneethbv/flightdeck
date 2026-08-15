import http, { IncomingMessage, ServerResponse, Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
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
import { PlaybookEngine, type EngineServices, type RunResult } from '../playbooks/engine.js';
import type { Playbook } from '../playbooks/types.js';
import { ToolRegistry, type McpContext } from '../mcp/tools.js';
import { isHarnessKind } from '../core/types.js';
import { getDefaultHarness } from '../core/config.js';
import { getAdapter } from '../sessions/harness.js';
import { TelemetryStore } from '../sessions/telemetry.js';
import { spawnSync } from 'node:child_process';
import type { Session } from '../core/types.js';

/**
 * How long a dashboard confirmation prompt stays open before the run fails
 * closed (the pending confirmation resolves as denied). Overridable in tests.
 */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Session ids are minted with crypto.randomUUID, so a well-formed id is a
 * UUID. Anything else in a /api/sessions/<id>/<action> path is rejected before
 * it can be turned into a filesystem path, closing the traversal hole in the
 * raw request target.
 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionIdFromPath(pathname: string, suffix: string): string | null {
  if (!pathname.startsWith('/api/sessions/') || !pathname.endsWith(suffix)) return null;
  const id = pathname.slice('/api/sessions/'.length, -suffix.length);
  return SESSION_ID_RE.test(id) ? id : null;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * The session row carries the secret token that gates this session's MCP
 * server, and the Argus row carries the manager capability. Neither may cross
 * into the browser: together they are the whole isolation model.
 */
function publicSession(session: Session): Omit<Session, 'token'> {
  const { token: _token, ...rest } = session;
  return rest;
}

export interface WebServerOptions {
  port?: number;
  projectRoot?: string;
  staticDir?: string;
  /** How long a confirmation prompt stays open before it resolves as denied. */
  confirmTimeoutMs?: number;
}

interface PendingConfirmation {
  prompt: string;
  /** The exact operation this challenge was issued for; a confirm must match it. */
  operation: string;
  timer: NodeJS.Timeout;
  resolve: (approved: boolean) => void;
}

interface PendingRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'awaiting_confirmation';
  result?: RunResult;
  error?: string;
  confirmId?: string;
  confirmPrompt?: string;
  confirmOperation?: string;
}

/** Stable identity for a tool invocation, binding a confirm to tool + args. */
function operationForTool(tool: string, args: Record<string, unknown>): string {
  const digest = createHash('sha1').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 12);
  return `tool:${tool}:${digest}`;
}

export function createWebServer(opts: WebServerOptions = {}): {
  server: Server;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  capabilityToken: string;
} {
  const projectRoot = normalizeProjectRoot(opts.projectRoot ?? process.cwd());
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, '..', 'web', 'public');
  const srcDir = path.resolve(here, '..', '..', 'src', 'web', 'public');
  const staticDir: string =
    opts.staticDir ?? (fs.existsSync(distDir) ? distDir : fs.existsSync(srcDir) ? srcDir : path.resolve(process.cwd(), 'src', 'web', 'public'));

  const sseClients = new Set<ServerResponse>();

  // Session-scoped capability token. Every /api/* request must present it;
  // static assets are served without it so the page can load and read the
  // token from the URL fragment. It is printed with the URL at startup.
  const capabilityToken = randomUUID();
  const pendingRuns = new Map<string, PendingRun>();
  const pendingConfirms = new Map<string, PendingConfirmation>();
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;

  /**
   * The token travels in the X-Flightdeck-Token header on every /api/* call.
   * The one exception is /api/events, where EventSource cannot set headers, so
   * the token rides the query string there and only there. The query string
   * must never be written to a request log.
   */
  function isAuthorized(req: IncomingMessage, pathname: string): boolean {
    const header = req.headers['x-flightdeck-token'];
    if (header === capabilityToken) return true;
    if (pathname === '/api/events') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      return url.searchParams.get('token') === capabilityToken;
    }
    return false;
  }

  /**
   * A confirm that suspends the run until the browser client posts a decision
   * for the minted confirm id, bound to the exact operation it was issued for.
   * A run never auto-confirms: a timeout or a denied request resolves false
   * and the step fails. Each challenge is single-use and expires.
   */
  function makeConfirmRequester(run: PendingRun): (prompt: string, operation: string) => Promise<boolean> {
    return (prompt: string, operation: string) =>
      new Promise<boolean>((resolve) => {
        const confirmId = randomUUID();
        const timer = setTimeout(() => {
          pendingConfirms.delete(confirmId);
          run.status = 'running';
          run.confirmId = undefined;
          run.confirmPrompt = undefined;
          run.confirmOperation = undefined;
          resolve(false);
        }, confirmTimeoutMs);
        pendingConfirms.set(confirmId, { prompt, operation, timer, resolve });
        run.status = 'awaiting_confirmation';
        run.confirmId = confirmId;
        run.confirmPrompt = prompt;
        run.confirmOperation = operation;
      });
  }

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
    const telemetryStore = new TelemetryStore(projectRoot);

    const argusList = argusManager.list();
    const fleets: Record<string, unknown>[] = [];
    for (const a of argusList) {
      const f = argusManager.fleet(a.id);
      const { cap: _cap, ...fleet } = a;
      fleets.push({
        ...fleet,
        children: f.children.map((c) => ({
          ...c,
          session: c.session ? publicSession(c.session) : c.session,
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
      sessions: sm.list().map((s) => ({
        ...publicSession(s),
        telemetry: telemetryStore.get(s.id),
      })),
      argus: fleets,
      notes: notesStore.list(),
      tables: tablesStore.listTables(),
      messages: messaging.list({ limit: 30 }),
      watchdog: {
        hungSessions: watchdog.listHung(300),
      },
      worktrees,
      playbooks: [...playbookNames].sort((a, b) => a.localeCompare(b)),
      defaultHarness: getDefaultHarness(),
    };
  }

  /**
   * Run a toolkit playbook. This function is the dashboard's only ToolRegistry
   * choke point: every tool invocation from the dashboard goes through it, so
   * nothing can reach a tool without clearing the confirmation path below.
   *
   * The dashboard is deliberately narrower than an Argus manager session. A
   * manager whose Argus row grants risky tools auto-passes the permission gate
   * with no confirmation; the dashboard keeps those tools invocable (the spec
   * requires destructive and externally-executing tools reachable from the
   * dashboard to go through a confirmation round trip) but never auto-confirms:
   * every such tool, and every manual step, suspends the run until a human in
   * the UI approves or denies the exact pending operation.
   */
  async function executeToolkitRun(
    run: PendingRun,
    playbook: Playbook,
    inputs: Record<string, unknown> | undefined
  ): Promise<void> {
    const requestConfirm = makeConfirmRequester(run);
    try {
      const ctx: McpContext = {
        projectRoot,
        sessionId: null,
        policy: 'default',
        isManager: true,
        riskyTools: true,
        confirm: (prompt) => requestConfirm(prompt, `manual:${prompt}`),
      };
      const registry = new ToolRegistry(ctx);
      const services: EngineServices = {
        projectRoot,
        tables: new TablesStore(projectRoot),
        notes: new NotesStore(projectRoot),
        messaging: new MessagingStore(projectRoot),
        callMcpTool: async (tool, args) => {
          const def = registry.tools.get(tool);
          if (def && (def.risk === 'destructive' || def.risk === 'external')) {
            const approved = await requestConfirm(`Run "${tool}"?`, operationForTool(tool, args));
            if (!approved) throw new Error(`"${tool}" was not approved by the user`);
          }
          return registry.call(tool, args);
        },
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
        readPlaybook: (n) => (n in BUILTIN_PLAYBOOKS ? parsePlaybookYaml(BUILTIN_PLAYBOOKS[n], n) : null),
        confirm: (prompt) => requestConfirm(prompt, `manual:${prompt}`),
      };
      const engine = new PlaybookEngine(services);
      const result = await engine.run(playbook, { inputs });
      run.result = result;
      run.status = result.ok ? 'succeeded' : 'failed';
      if (!result.ok) run.error = result.error;
    } catch (err) {
      run.status = 'failed';
      run.error = (err as Error).message;
    } finally {
      run.confirmId = undefined;
      run.confirmPrompt = undefined;
      run.confirmOperation = undefined;
      broadcastUpdate();
    }
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
      // No CORS headers are sent: the dashboard is same-origin only, and a
      // cross-origin site must not be able to read any /api/* response.
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    const [pathname] = url.split('?');

    // Every /api/* request must present the capability token printed with the
    // URL at startup. Static assets are unauthenticated so the page can load.
    if (pathname.startsWith('/api/') && !isAuthorized(req, pathname)) {
      sendError(res, 401, 'missing or invalid capability token');
      return;
    }

    // 1. SSE Events Stream
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
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
        sendJson(res, 200, publicSession(started));
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/stop') && req.method === 'POST') {
      try {
        const id = sessionIdFromPath(pathname, '/stop');
        if (!id) throw new Error('invalid session id');
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
        const id = sessionIdFromPath(pathname, '/logs');
        if (!id) throw new Error('invalid session id');
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
    // A run is started in the background and its lifecycle is polled, so a
    // destructive or externally-executing tool can suspend it on a
    // confirmation round trip instead of being auto-approved.
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
        const runId = randomUUID();
        const run: PendingRun = { id: runId, status: 'running' };
        pendingRuns.set(runId, run);
        void executeToolkitRun(run, playbook, (body.inputs as Record<string, unknown>) ?? undefined);
        sendJson(res, 202, { runId, status: 'running' });
      } catch (err) {
        sendError(res, 400, (err as Error).message);
      }
      return;
    }

    if (pathname.startsWith('/api/toolkit/run/') && req.method === 'GET') {
      const runId = decodeURIComponent(pathname.slice('/api/toolkit/run/'.length));
      const run = pendingRuns.get(runId);
      if (!run) {
        sendError(res, 404, `toolkit run "${runId}" not found`);
        return;
      }
      sendJson(res, 200, {
        runId,
        status: run.status,
        result: run.result,
        error: run.error,
        confirm: run.confirmId
          ? { id: run.confirmId, prompt: run.confirmPrompt, operation: run.confirmOperation }
          : undefined,
      });
      return;
    }

    if (pathname === '/api/toolkit/confirm' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const confirmId = typeof body.confirmId === 'string' ? body.confirmId : '';
        const operation = typeof body.operation === 'string' ? body.operation : '';
        const pending = pendingConfirms.get(confirmId);
        if (!pending) {
          sendError(res, 404, `no pending confirmation "${confirmId}"`);
          return;
        }
        if (pending.operation !== operation) {
          sendError(res, 400, 'confirmation does not match the pending operation');
          return;
        }
        clearTimeout(pending.timer);
        pendingConfirms.delete(confirmId);
        const approved = body.ok === true;
        pending.resolve(approved);
        sendJson(res, 200, { confirmed: approved });
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
    capabilityToken,
  };
}
