import { describe, expect, it } from 'vitest';

import type { ArtifactRow } from '@orcaops/storage';

import { deriveLabel } from './active-artifact.js';

// deriveLabel only reads `label` + `task`; cast a minimal row.
const row = (over: Partial<ArtifactRow>): ArtifactRow =>
  ({ id: 'a', task: 'the task', label: undefined, ...over }) as ArtifactRow;

describe('deriveLabel', () => {
  it('uses the plan headline when present', () => {
    expect(deriveLabel(row({ label: 'Rate limit /api/charge' }))).toBe('Rate limit /api/charge');
  });

  it("falls back to task when label is the 'unlabelled' sentinel", () => {
    expect(deriveLabel(row({ label: 'unlabelled' }))).toBe('the task');
  });

  it('falls back to task when label is missing', () => {
    expect(deriveLabel(row({ label: undefined }))).toBe('the task');
  });
});
