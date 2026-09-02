import { describe, expect, it } from 'vitest';

import { CURATED_HINT_KEYS } from '@orcaops/storage';

import { CURATED_HINTS, resolveHintLines } from './hints-catalog.js';

describe('curated hint catalog', () => {
  it('covers every storage hint key exactly once, in canonical order', () => {
    // Parity guard: a new key in storage MUST get prose here (or this fails).
    expect(CURATED_HINTS.map((h) => h.key)).toEqual([...CURATED_HINT_KEYS]);
  });

  it('renders curated prose in canonical order regardless of selection order', () => {
    const a = resolveHintLines({
      keys: ['checkpoint-cadence', 'commit-on-checkpoint-close'],
      custom: [],
    });
    const b = resolveHintLines({
      keys: ['commit-on-checkpoint-close', 'checkpoint-cadence'],
      custom: [],
    });
    expect(a).toEqual(b); // selection order is irrelevant
    expect(a[0]).toBe(
      'Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.'
    ); // canonical catalog order
  });

  it('appends custom lines verbatim after curated, dropping blanks', () => {
    const lines = resolveHintLines({
      keys: ['commit-on-checkpoint-close'],
      custom: ['  ', 'Run pnpm -r test before claiming done.'],
    });
    expect(lines).toEqual([
      'Open the checkpoint, make changes, run formatters and tests, commit (including hook rewrites), then close.',
      'Run pnpm -r test before claiming done.',
    ]);
  });

  it('returns [] for empty or undefined hints', () => {
    expect(resolveHintLines({ keys: [], custom: [] })).toEqual([]);
    expect(resolveHintLines(undefined)).toEqual([]);
  });
});
describe('the one-line render constraint', () => {
  it('no curated hint can contain a newline or a tab', () => {
    // template.ts renders each hint as a single `- ${h}` bullet. A newline in
    // the prose does not error — it silently emits a broken list into every
    // generated CLAUDE.md/AGENTS.md, which is why this is pinned rather than
    // left to review.
    for (const hint of CURATED_HINTS) {
      expect(hint.prose, `hint ${hint.key} must render on one line`).not.toMatch(/[\n\r\t]/);
      expect(hint.prose.trim(), `hint ${hint.key} must not pad`).toBe(hint.prose);
      expect(hint.prose.length, `hint ${hint.key} is unreadably long`).toBeLessThan(140);
    }
  });
});
