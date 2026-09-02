import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  stringifyTerminalSafeJson,
  stripTerminalControls,
  stripTerminalFormatting,
} from './terminal.js';

const control = (code: number): string => String.fromCharCode(code);

describe('stripTerminalControls', () => {
  it('neutralizes seven-bit and eight-bit terminal commands', () => {
    const input =
      `before${control(0x1b)}[8;1Hhidden` +
      `${control(0x1b)}]52;c;cG9pc29u${control(0x07)}` +
      `${control(0x9b)}2Jafter`;

    const output = stripTerminalControls(input);

    expect(output).toContain('before');
    expect(output).toContain('hidden');
    expect(output).toContain('after');
    expect(
      [...output].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
      })
    ).toBe(false);
  });

  it('removes bidirectional display controls without removing their visible text', () => {
    const input = 'command: safe\u202e]hs.nur/.[\u2066 end';
    const output = stripTerminalControls(input);

    expect(output).toBe('command: safe]hs.nur/.[ end');
  });

  it('preserves tabs, newlines, and ordinary Unicode text', () => {
    const text = 'heading\n\tinspect π and 🐋\n';
    expect(stripTerminalControls(text)).toBe(text);
  });

  it('handles a bounded-output-sized string with one leading control', () => {
    const visible = 'x'.repeat(8 * 1024 * 1024);
    expect(stripTerminalControls(`${control(0x1b)}${visible}`)).toBe(visible);
  });

  it('bounds intermediate segments for dense alternating controls', () => {
    const visible = 'x'.repeat(1024 * 1024);
    expect(stripTerminalControls(`${control(0x1b)}x`.repeat(visible.length))).toBe(visible);
  });

  it('survives a bounded heap on maximum-sized sparse hostile input', () => {
    const terminalUrl = new URL('./terminal.ts', import.meta.url).href;
    const storageControlUrl = new URL('../../storage/src/text/control-chars.ts', import.meta.url)
      .href;
    const script = `
      const [{ stripTerminalControls }, { stripControlChars }] = await Promise.all([
        import(${JSON.stringify(terminalUrl)}),
        import(${JSON.stringify(storageControlUrl)})
      ]);
      const visible = 'x'.repeat(8 * 1024 * 1024);
      if (stripTerminalControls(String.fromCharCode(0x1b) + visible) !== visible) process.exit(2);
      if (stripControlChars(String.fromCharCode(0x00) + visible) !== visible) process.exit(3);
    `;

    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--max-old-space-size=128',
          '--no-warnings',
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          script,
        ],
        { timeout: 15_000, stdio: 'pipe' }
      )
    ).not.toThrow();
  }, 20_000);
});

describe('stripTerminalFormatting', () => {
  it('removes complete CSI and OSC sequences with their printable parameters', () => {
    const esc = control(0x1b);
    const bell = control(0x07);
    const input = `before${esc}[31mred${esc}[0m${esc}]52;c;payload${bell}after`;

    expect(stripTerminalFormatting(input)).toBe('beforeredafter');
  });

  it('continues a CSI sequence across embedded C0 controls and DEL', () => {
    const esc = control(0x1b);
    const input = `before${esc}[3${control(0x07)}1${control(0x7f)}mred${esc}[0mafter`;

    expect(stripTerminalFormatting(input)).toBe('beforeredafter');
  });

  it('keeps printable bytes after an incomplete sequence introducer', () => {
    expect(stripTerminalFormatting(`before${control(0x1b)}[31`)).toBe('before[31');
  });

  it('handles repeated unterminated OSC sequences in one pass', () => {
    const fragment = `${control(0x1b)}]${'x'.repeat(32)}`;
    const output = stripTerminalFormatting(fragment.repeat(20_000));

    expect(output).toBe(`]${'x'.repeat(32)}`.repeat(20_000));
  });
});

describe('stringifyTerminalSafeJson', () => {
  it('escapes terminal controls without changing the decoded value', () => {
    const value = {
      text: `before${control(0x1b)}[2J${control(0x9b)}after\u202eoverride`,
    };
    const serialized = stringifyTerminalSafeJson(value);

    expect(serialized).not.toContain(control(0x1b));
    expect(serialized).not.toContain(control(0x9b));
    expect(serialized).not.toContain('\u202e');
    expect(JSON.parse(serialized)).toEqual(value);
  });

  it('preserves terminal safety and decoded values in pretty output', () => {
    const value = { text: `before${control(0x9b)}after` };
    const serialized = stringifyTerminalSafeJson(value, 2);

    expect(serialized).toContain('\n  "text":');
    expect(serialized).not.toContain(control(0x9b));
    expect(JSON.parse(serialized)).toEqual(value);
  });
});
