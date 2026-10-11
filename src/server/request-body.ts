import type { IncomingMessage } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bound bytes before decoding so split UTF-8 characters remain intact. */
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const value = await new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new RequestError(413, 'Request body exceeds 1 MiB'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new RequestError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('aborted', () => reject(new RequestError(400, 'Request body was interrupted')));
    req.on('error', reject);
  });
  if (!isRecord(value)) throw new RequestError(400, 'Request body must be an object');
  return value;
}
