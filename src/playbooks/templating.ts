export interface TemplateContext {
  inputs: Record<string, unknown>;
  vars: Record<string, unknown>;
  secrets: Record<string, string>;
  steps: Record<string, unknown>;
}

export function resolveTemplate(template: unknown, ctx: TemplateContext): unknown {
  if (typeof template === 'string') {
    if (template.includes('{{')) {
      return template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path: string) => {
        const value = resolvePath(path, ctx);
        if (value === undefined) {
          throw new Error(`template path "${path}" not found`);
        }
        return typeof value === 'string' ? value : JSON.stringify(value);
      });
    }
    return template;
  }
  if (Array.isArray(template)) {
    return template.map((item) => resolveTemplate(item, ctx));
  }
  if (template !== null && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      out[key] = resolveTemplate(value, ctx);
    }
    return out;
  }
  return template;
}

function getRootContext(head: string, ctx: TemplateContext): unknown {
  switch (head) {
    case 'inputs':
      return ctx.inputs;
    case 'vars':
      return ctx.vars;
    case 'secrets':
      return ctx.secrets;
    case 'steps':
      return ctx.steps;
    default:
      return undefined;
  }
}

function resolvePart(current: unknown, part: string): unknown {
  if (current === null || typeof current !== 'object') return undefined;
  const obj = current as Record<string, unknown>;
  if (part in obj) return obj[part];
  if (obj.output !== null && typeof obj.output === 'object' && part in (obj.output as Record<string, unknown>)) {
    return (obj.output as Record<string, unknown>)[part];
  }
  return undefined;
}

function resolvePath(path: string, ctx: TemplateContext): unknown {
  const parts = path.split('.');
  let value: unknown = getRootContext(parts[0], ctx);
  for (let i = 1; i < parts.length; i++) {
    value = resolvePart(value, parts[i]);
    if (value === undefined) return undefined;
  }
  return value;
}

export function resolveTemplateLoose(template: unknown, ctx: TemplateContext): unknown {
  try {
    return resolveTemplate(template, ctx);
  } catch {
    return template;
  }
}
