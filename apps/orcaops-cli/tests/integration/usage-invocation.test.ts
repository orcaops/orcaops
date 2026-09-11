import { afterEach, describe, expect, it, vi } from 'vitest';

import { usageAction } from '../../src/commands/usage.js';
import { runInInvocationContext } from '../../src/lib/invocation-context.js';
import { fixture, inventory } from '../helpers/database-history.js';
import { tokens, usageObservation } from '../helpers/database-usage.js';

afterEach(() => vi.restoreAllMocks());
async function observe(
  f: { main: string; root: string },
  options: Parameters<typeof usageAction>[0],
  mutate: () => void = () => {}
) {
  const output: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  try {
    await runInInvocationContext(
      {
        cwd: f.main,
        env: { ...process.env, ORCAOPS_DATA_DIR: f.root, ORCAOPS_DISABLE_DRAIN: '1' },
      },
      async () => {
        const pending = usageAction(options);
        mutate();
        await pending;
      }
    );
    return JSON.parse(output.join(''));
  } finally {
    spy.mockRestore();
  }
}

describe('usage invocation identity', { timeout: 30_000 }, () => {
  it('retains the original artifact while its context opens', async () => {
    const f = await fixture();
    const first = await f.capture();
    const second = await f.capture();
    await usageObservation(f.writer, first, 10, { session_id: 'first-session' });
    await usageObservation(f.writer, second, 20, { session_id: 'second-session' });
    const before = await inventory(f.temporary);
    const options = { artifact: first, json: true };
    const result = await observe(f, options, () => {
      options.artifact = second;
    });
    expect(result.artifact_id).toBe(first);
    expect(result.usage.accounting.totals).toEqual(tokens(10));
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('retains the original recorded-path filter while its context opens', async () => {
    const f = await fixture();
    const first = await f.capture();
    const second = await f.capture();
    await f.recordFiles(first, ['src/first.ts']);
    await f.recordFiles(second, ['src/second.ts']);
    await usageObservation(f.writer, first, 10, { session_id: 'first-session' });
    await usageObservation(f.writer, second, 20, { session_id: 'second-session' });
    const before = await inventory(f.temporary);
    const options = { touching: 'src/first.ts', json: true };
    const result = await observe(f, options, () => {
      options.touching = 'src/second.ts';
    });
    expect(result.filters.touching).toBe('src/first.ts');
    expect(result.usage.accounting.totals).toEqual(tokens(10));
    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('preserves exact totals and passivity for an unchanged invocation', async () => {
    const f = await fixture();
    const first = await f.capture();
    await usageObservation(f.writer, first, 10);
    const before = await inventory(f.temporary);
    const result = await observe(f, { artifact: first, json: true });
    expect(result.artifact_id).toBe(first);
    expect(result.usage.accounting.totals).toEqual(tokens(10));
    expect(await inventory(f.temporary)).toEqual(before);
  });
});
