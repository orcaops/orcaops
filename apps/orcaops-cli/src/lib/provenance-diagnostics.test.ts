import { expect, it } from 'vitest';

import { summarizeProvenanceIssues } from './provenance-output.js';

it('groups repeated warnings without losing distinct causes or total occurrences', () => {
  const issues = Array.from({ length: 25 }, (_, i) => ({
    code: 'PROVENANCE_INDEX_OMITTED' as const,
    message: i === 24 ? 'A source is restricted.' : 'Original evidence is unavailable.',
    artifact_id: `artifact-${i}`,
  }));
  const summary = summarizeProvenanceIssues(issues);
  expect(summary.total).toBe(25);
  expect(summary.omitted).toBe(0);
  expect(summary.items.map((item) => item.occurrences)).toEqual([24, 1]);
  expect(summary.items[1]?.message.text).toBe('A source is restricted.');
  expect(summary.code_counts).toEqual([{ code: 'PROVENANCE_INDEX_OMITTED', count: 25 }]);
  expect(summary.source_details).toBe('inspect_audit');
  expect(JSON.stringify(summary)).not.toContain('artifact-');
});

it('discloses warning groups omitted by the preview bound', () => {
  const summary = summarizeProvenanceIssues(
    Array.from({ length: 15 }, (_, i) => ({
      code: 'PROVENANCE_INDEX_OMITTED' as const,
      message: `Different cause ${i}`,
    }))
  );
  expect(summary.items).toHaveLength(10);
  expect(summary.omitted).toBe(5);
  expect(summary.total).toBe(15);
});
