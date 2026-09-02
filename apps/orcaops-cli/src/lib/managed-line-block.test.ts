import { describe, expect, it } from 'vitest';

import {
  inspectManagedLineBlock,
  ORCAOPS_MANAGED_BLOCK_END,
  ORCAOPS_MANAGED_BLOCK_START,
  reconcileManagedLineBlock,
} from './managed-line-block.js';

const block = (lines: string[], eol = '\n'): string =>
  [ORCAOPS_MANAGED_BLOCK_START, ...lines, ORCAOPS_MANAGED_BLOCK_END].join(eol);

describe('reconcileManagedLineBlock — reading the file back unchanged', () => {
  it('leaves a CRLF file alone when its block is already current', () => {
    const existing = `node_modules\r\n\r\n${block(['.orcaops/'], '\r\n')}\r\n`;
    expect(reconcileManagedLineBlock(existing, ['.orcaops/']).desiredContent).toBeNull();
  });

  it('writes CRLF into a CRLF file rather than normalizing it to LF', () => {
    const existing = 'node_modules\r\ndist\r\n';
    const next = reconcileManagedLineBlock(existing, ['.orcaops/']).desiredContent;
    expect(next).toBe(`node_modules\r\ndist\r\n\r\n${block(['.orcaops/'], '\r\n')}\r\n`);
    expect(next).not.toContain('\n\n');
  });

  it('keeps LF for a file with only a stray CRLF among LF endings', () => {
    const existing = 'a\nb\r\nc\nd\n';
    const next = reconcileManagedLineBlock(existing, ['.orcaops/']).desiredContent;
    expect(next?.includes('\r\n')).toBe(false);
  });

  it('does not rewrite a current file purely to add a trailing newline', () => {
    const existing = `node_modules\n\n${block(['.orcaops/'])}`;
    expect(reconcileManagedLineBlock(existing, ['.orcaops/']).desiredContent).toBeNull();
  });

  it('leaves a file orcaops owns nothing in untouched', () => {
    for (const existing of ['*.swp', '*.swp\n', 'a\r\nb', '']) {
      expect(reconcileManagedLineBlock(existing, []).desiredContent).toBeNull();
    }
  });
});

describe('reconcileManagedLineBlock — stripping the block', () => {
  it('renders empty when nothing but blank lines would remain', () => {
    const existing = `${block(['.orcaops/'])}\n`;
    expect(reconcileManagedLineBlock(existing, []).desiredContent).toBe('');
  });

  it('renders empty for a block-only file with no trailing newline', () => {
    expect(reconcileManagedLineBlock(block(['.orcaops/']), []).desiredContent).toBe('');
  });

  it('keeps user content and reports what left the block', () => {
    const existing = `node_modules\n\n${block(['.orcaops/', 'stale/'])}\n`;
    const plan = reconcileManagedLineBlock(existing, ['.orcaops/']);
    expect(plan.desiredContent).toBe(`node_modules\n\n${block(['.orcaops/'])}\n`);
    expect(plan.removed).toEqual(['stale/']);
    expect(plan.added).toEqual([]);
  });
});

describe('inspectManagedLineBlock — ownership boundaries', () => {
  it('claims only what is inside the markers', () => {
    const existing = `.orcaops/\n${block(['dist/'])}\n`;
    const state = inspectManagedLineBlock(existing);
    expect(state.claimed).toBe(true);
    expect(state.managedLines).toEqual(['dist/']);
  });

  it('treats an unterminated start marker as user content', () => {
    const state = inspectManagedLineBlock(`${ORCAOPS_MANAGED_BLOCK_START}\ndist/\n`);
    expect(state.claimed).toBe(false);
    expect(state.managedLines).toEqual([]);
  });
});
