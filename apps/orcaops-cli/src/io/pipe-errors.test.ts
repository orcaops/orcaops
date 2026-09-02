import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { installPipeErrorHandling } from './exit.js';

describe('installPipeErrorHandling', () => {
  it('exits cleanly when the reader closes the pipe', () => {
    const stream = new PassThrough();
    const exits: number[] = [];
    installPipeErrorHandling([stream], (code) => exits.push(code));

    const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
    epipe.code = 'EPIPE';
    stream.emit('error', epipe);

    expect(exits).toEqual([0]);
  });

  it('leaves any other stream error to crash as before', () => {
    const stream = new PassThrough();
    const exits: number[] = [];
    installPipeErrorHandling([stream], (code) => exits.push(code));

    const enospc: NodeJS.ErrnoException = new Error('write ENOSPC');
    enospc.code = 'ENOSPC';

    expect(() => stream.emit('error', enospc)).toThrow('write ENOSPC');
    expect(exits).toEqual([]);
  });

  it('guards every stream it is given', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const exits: number[] = [];
    installPipeErrorHandling([stdout, stderr], (code) => exits.push(code));

    for (const stream of [stdout, stderr]) {
      const epipe: NodeJS.ErrnoException = new Error('write EPIPE');
      epipe.code = 'EPIPE';
      stream.emit('error', epipe);
    }

    expect(exits).toEqual([0, 0]);
  });
});
