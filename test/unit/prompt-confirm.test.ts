import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptConfirm } from '../../src/cli/util.js';

function answer(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  setImmediate(() => stream.write(`${text}\n`));
  return stream;
}

describe('promptConfirm', () => {
  it('accepts y and Y', async () => {
    expect(await promptConfirm('go?', answer('y'))).toBe(true);
    expect(await promptConfirm('go?', answer('Y'))).toBe(true);
  });

  it('treats an empty answer and anything else as no', async () => {
    expect(await promptConfirm('go?', answer(''))).toBe(false);
    expect(await promptConfirm('go?', answer('nope'))).toBe(false);
  });

  it('denies an aborted prompt and removes its input listener', async () => {
    const input = new PassThrough();
    const controller = new AbortController();
    const pending = promptConfirm('go?', input, controller.signal);
    controller.abort();
    input.write('y\n');
    expect(await pending).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    input.end();
  });

  it('denies a prompt when input closes without an answer', async () => {
    const input = new PassThrough();
    const pending = promptConfirm('go?', input);
    input.end();
    expect(await pending).toBe(false);
  });
});
