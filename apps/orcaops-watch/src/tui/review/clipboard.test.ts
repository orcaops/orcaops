import { describe, expect, it, vi } from 'vitest';

import { type CopyLine, copyViaOsc52, formatSelectionText, osc52Payload } from './clipboard';

describe('osc52Payload', () => {
  it('frames base64 of the UTF-8 text with OSC 52 (ESC ] 52 ; c ; … BEL)', () => {
    const out = osc52Payload('hello');
    expect(out).toBe(`\x1b]52;c;${Buffer.from('hello').toString('base64')}\x07`);
    expect(out.startsWith('\x1b]52;c;')).toBe(true);
    expect(out.endsWith('\x07')).toBe(true);
  });

  it('base64-encodes multi-line and unicode payloads round-trip', () => {
    const text = 'const λ = 1\nconst μ = 2';
    const b64 = osc52Payload(text).slice('\x1b]52;c;'.length, -1);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(text);
  });
});

describe('formatSelectionText', () => {
  const lines: CopyLine[] = [
    { side: 'add', line: 8, body: '  const x = 1;' },
    { side: 'add', line: 9, body: '  return x;' },
  ];

  it('defaults to raw code bodies joined by newlines (decorations OFF)', () => {
    expect(formatSelectionText(lines)).toBe('  const x = 1;\n  return x;');
    expect(formatSelectionText(lines, {})).toBe('  const x = 1;\n  return x;');
  });

  it('prefixes right-aligned line numbers when decorations are ON', () => {
    const spanned: CopyLine[] = [
      { side: 'add', line: 9, body: 'a' },
      { side: 'add', line: 10, body: 'b' },
    ];
    expect(formatSelectionText(spanned, { lineNumbers: true })).toBe(' 9│ a\n10│ b');
  });

  it('handles an empty selection', () => {
    expect(formatSelectionText([])).toBe('');
  });
});

describe('copyViaOsc52', () => {
  it('reports native when the renderer OSC 52 write succeeds', () => {
    const calls: string[] = [];
    const renderer = {
      copyToClipboardOSC52: (t: string) => {
        calls.push(t);
        return true;
      },
    };
    expect(copyViaOsc52(renderer, 'code')).toBe('native');
    expect(calls).toEqual(['code']);
  });

  it('falls back to a direct escape write when the native path returns false', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const renderer = { copyToClipboardOSC52: () => false };
      expect(copyViaOsc52(renderer, 'code')).toBe('fallback');
      expect(spy).toHaveBeenCalledWith(osc52Payload('code'));
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back when there is no renderer at all', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      expect(copyViaOsc52(null, 'code')).toBe('fallback');
      expect(spy).toHaveBeenCalledWith(osc52Payload('code'));
    } finally {
      spy.mockRestore();
    }
  });

  it('reports none when neither the native nor the direct write works', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('no tty');
    });
    try {
      expect(copyViaOsc52({ copyToClipboardOSC52: () => false }, 'code')).toBe('none');
    } finally {
      spy.mockRestore();
    }
  });
});
