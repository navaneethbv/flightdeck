import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDb } from '../core/state.js';
import { rowToSession } from '../sessions/manager.js';
import type { SessionPolicy } from '../core/types.js';
import { ToolRegistry } from './tools.js';
import { log } from '../core/logger.js';

function objectSchemaToZod(def: Record<string, unknown>): z.ZodType {
  const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = (def.required ?? []) as string[];
  const shape: Record<string, z.ZodType> = {};
  for (const [k, d] of Object.entries(props)) {
    const t = toZodType(d);
    shape[k] = req.includes(k) ? t : t.optional();
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : z.record(z.string(), z.any());
}

function toZodType(def: Record<string, unknown> | undefined): z.ZodType {
  if (!def) return z.any();
  let schema: z.ZodType;
  if (Array.isArray(def.enum) && def.enum.length > 0 && def.enum.every((e) => typeof e === 'string')) {
    schema = z.enum(def.enum as [string, ...string[]]);
  } else {
    switch (def.type) {
      case 'string':
        schema = z.string();
        break;
      case 'number':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      case 'array':
        schema = z.array(toZodType(def.items as Record<string, unknown> | undefined));
        break;
      case 'object':
        schema = objectSchemaToZod(def);
        break;
      default:
        schema = z.any();
        break;
    }
  }
  if (typeof def.description === 'string') {
    schema = schema.describe(def.description);
  }
  return schema;
}

function jsonSchemaToRawShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(props)) {
    const type = toZodType(def);
    shape[key] = required.includes(key) ? type : type.optional();
  }
  return shape;
}

export interface ServeOptions {
  projectRoot: string;
  sessionId: string;
  token: string;
}

export async function serveMcp(opts: ServeOptions): Promise<void> {
  const db = getDb(opts.projectRoot);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(opts.sessionId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`session "${opts.sessionId}" not found`);
  if (String(row.token) !== opts.token) throw new Error('invalid session token');

  const session = rowToSession(row);
  const policy: SessionPolicy = session.policy === 'child' ? 'child' : 'default';
  let isManager = false;
  let riskyTools = false;

  if (session.argusParent) {
    const argus = db.prepare('SELECT * FROM argus WHERE id = ?').get(session.argusParent) as
      | { risky_tools: number }
      | undefined;
    riskyTools = argus?.risky_tools === 1;
  }
  if (session.policy === 'manager') {
    const argus = db
      .prepare('SELECT * FROM argus WHERE manager_session_id = ?')
      .get(session.id) as { cap: string; risky_tools: number } | undefined;
    if (argus && process.env.FLIGHTDECK_ARGUS_CAP === argus.cap) {
      isManager = true;
      riskyTools = argus.risky_tools === 1;
    }
  }

  const registry = new ToolRegistry({
    projectRoot: opts.projectRoot,
    sessionId: session.id,
    policy,
    isManager,
    riskyTools,
    confirm: async () => false,
  });

  const server = new McpServer({ name: 'flightdeck', version: '0.1.0' });
  for (const tool of registry.tools.values()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: jsonSchemaToRawShape(tool.inputSchema),
      },
      (async (args: Record<string, unknown> | undefined) => {
        try {
          const result = await registry.call(tool.name, (args ?? {}) as Record<string, unknown>);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          log.error(`mcp tool ${tool.name} failed: ${(err as Error).message}`);
          return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
        }
      }) as never
    );
  }

  log.info(`mcp server ready for session ${opts.sessionId} project=${opts.projectRoot} policy=${policy} manager=${isManager}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
