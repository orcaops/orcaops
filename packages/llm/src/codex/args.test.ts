import { describe, expect, it } from 'vitest';

import { buildCodexArgs, buildCodexEnv } from './args.js';

describe('buildCodexArgs', () => {
  it('emits the orcaops baseline flags', () => {
    const args = buildCodexArgs({ outputLastMessageFile: '/tmp/x.txt' });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    const sb = args.indexOf('--sandbox');
    expect(sb).toBeGreaterThan(-1);
    expect(args[sb + 1]).toBe('read-only');
    const co = args.indexOf('--color');
    expect(co).toBeGreaterThan(-1);
    expect(args[co + 1]).toBe('never');
    const om = args.indexOf('--output-last-message');
    expect(om).toBeGreaterThan(-1);
    expect(args[om + 1]).toBe('/tmp/x.txt');
  });

  it('reads prompt from stdin via trailing `-`', () => {
    const args = buildCodexArgs({ outputLastMessageFile: '/tmp/x.txt' });
    expect(args[args.length - 1]).toBe('-');
  });

  it('passes model when provided', () => {
    const args = buildCodexArgs({
      outputLastMessageFile: '/tmp/x.txt',
      model: 'gpt-5.2',
    });
    const m = args.indexOf('--model');
    expect(m).toBeGreaterThan(-1);
    expect(args[m + 1]).toBe('gpt-5.2');
  });

  it('passes output-schema file when provided', () => {
    const args = buildCodexArgs({
      outputLastMessageFile: '/tmp/x.txt',
      outputSchemaFile: '/tmp/schema.json',
    });
    const s = args.indexOf('--output-schema');
    expect(s).toBeGreaterThan(-1);
    expect(args[s + 1]).toBe('/tmp/schema.json');
  });

  it('omits optional flags when not set', () => {
    const args = buildCodexArgs({ outputLastMessageFile: '/tmp/x.txt' });
    expect(args.includes('--model')).toBe(false);
    expect(args.includes('--output-schema')).toBe(false);
  });
});

describe('buildCodexEnv', () => {
  it('sets CI hygiene env vars', () => {
    const env = buildCodexEnv();
    expect(env.CI).toBe('true');
    expect(env.TERM).toBe('dumb');
  });
});

describe('buildCodexArgs — tool policy', () => {
  const base = { outputLastMessageFile: '/tmp/out.txt' };

  it('refuses a command-filtered policy it cannot enforce', () => {
    // `--sandbox read-only` stops writes and denies no reads, so honouring
    // this would be a claim the provider cannot keep.
    expect(() => buildCodexArgs({ ...base, toolPolicy: { mode: 'command-filtered' } })).toThrow(
      /no read-denial mechanism/
    );
  });

  it('accepts an explicit none policy', () => {
    expect(() => buildCodexArgs({ ...base, toolPolicy: { mode: 'none' } })).not.toThrow();
  });

  it('accepts no policy at all', () => {
    expect(() => buildCodexArgs(base)).not.toThrow();
  });
});
