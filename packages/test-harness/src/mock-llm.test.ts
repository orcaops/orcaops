import { run } from 'effection';
import { describe, expect, it } from 'vitest';

import { createMockLLMClient } from './mock-llm.js';

describe('createMockLLMClient', () => {
  it('returns PASS by default', async () => {
    const mock = createMockLLMClient();
    const result = await run(() => mock.evaluate({ prompt: 'anything' }));
    expect(result.body.startsWith('PASS')).toBe(true);
    expect(result.model).toBe('mock');
  });

  it('records every evaluate() call', async () => {
    const mock = createMockLLMClient();
    await run(() => mock.evaluate({ prompt: 'one' }));
    await run(() => mock.evaluate({ prompt: 'two' }));
    expect(mock.calls.map((c) => c.prompt)).toEqual(['one', 'two']);
  });

  it('routes responses via the respond function', async () => {
    const mock = createMockLLMClient({
      respond: (opts) =>
        opts.prompt.includes('drift') ? { body: 'VIOLATION\n\n- bad' } : { body: 'PASS' },
    });
    const r1 = await run(() => mock.evaluate({ prompt: 'check for drift' }));
    const r2 = await run(() => mock.evaluate({ prompt: 'all good' }));
    expect(r1.body).toMatch(/VIOLATION/);
    expect(r2.body).toMatch(/PASS/);
  });

  it('reset() clears history', async () => {
    const mock = createMockLLMClient();
    await run(() => mock.evaluate({ prompt: 'x' }));
    expect(mock.calls).toHaveLength(1);
    mock.reset();
    expect(mock.calls).toHaveLength(0);
  });
});
