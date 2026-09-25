// The one reading of `--at-boundary`, whichever surface offers the flag.
import { describe, expect, it } from 'vitest';

import { knowledgeBoundaryOption } from './artifact-knowledge.js';

describe('the boundary a read was asked for', () => {
  it('reads a write sequence typed as digits, and one already parsed to a number', () => {
    expect(knowledgeBoundaryOption('40')).toBe(40);
    expect(knowledgeBoundaryOption(40)).toBe(40);
    expect(knowledgeBoundaryOption('0')).toBe(0);
  });

  it('reads an absent flag as the committed sequence rather than as a boundary', () => {
    expect(knowledgeBoundaryOption(undefined)).toBe('now');
  });

  it('refuses an empty value rather than reading it as boundary zero', () => {
    expect(() => knowledgeBoundaryOption('')).toThrow(/write sequence/u);
    expect(() => knowledgeBoundaryOption('   ')).toThrow(/write sequence/u);
  });

  it('refuses an exponent rather than reading it as the number it expands to', () => {
    expect(() => knowledgeBoundaryOption('1e3')).toThrow(/write sequence/u);
  });

  it('refuses a negative, a fraction, a git revision and a value nothing parsed', () => {
    expect(() => knowledgeBoundaryOption('-1')).toThrow(/write sequence/u);
    expect(() => knowledgeBoundaryOption('1.5')).toThrow(/write sequence/u);
    expect(() => knowledgeBoundaryOption('HEAD~1')).toThrow(/write sequence/u);
    expect(() => knowledgeBoundaryOption(Number.NaN)).toThrow(/write sequence/u);
  });

  it('names the flag it was given, so a surface reports its own', () => {
    expect(() => knowledgeBoundaryOption('nope', '--at')).toThrow(/--at takes/u);
  });
});
