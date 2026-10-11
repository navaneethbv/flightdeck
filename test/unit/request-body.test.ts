import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readBody } from '../../src/server/request-body.js';

describe('dashboard JSON body reader', () => {
  it('preserves UTF-8 characters split across network chunks', async () => {
    const stream = new PassThrough();
    const result = readBody(stream as IncomingMessage);
    const body = Buffer.from(JSON.stringify({ body: 'Hello 🌍, 你好' }));
    for (const byte of body) stream.write(Buffer.from([byte]));
    stream.end();
    expect(await result).toEqual({ body: 'Hello 🌍, 你好' });
  });

  it('rejects malformed JSON and aborted requests', async () => {
    const malformed = new PassThrough();
    const invalid = readBody(malformed as IncomingMessage);
    malformed.end('{');
    await expect(invalid).rejects.toMatchObject({ status: 400, message: 'Request body must be valid JSON' });
    const interrupted = new PassThrough();
    const aborted = readBody(interrupted as IncomingMessage);
    interrupted.emit('aborted');
    await expect(aborted).rejects.toMatchObject({ status: 400, message: 'Request body was interrupted' });
    interrupted.end();
  });
});
