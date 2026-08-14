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

function resolvePath(path: string, ctx: TemplateContext): unknown {
  const parts = path.split('.');
  const head = parts[0];
  let value: unknown;
  if (head === 'inputs') value = ctx.inputs;
  else if (head === 'vars') value = ctx.vars;
  else if (head === 'secrets') value = ctx.secrets;
  else if (head === 'steps') value = ctx.steps;
  else return undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (part in obj) {
        value = obj[part];
      } else if (obj.output !== null && typeof obj.output === 'object' && part in (obj.output as Record<string, unknown>)) {
        value = (obj.output as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    } else {
      return undefined;
    }
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
