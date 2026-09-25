import { describe, expect, it } from 'vitest';

import { INTERPRETATION_EVALUATION_SET } from './cases.js';
import { SCRIPTED_ANSWERS } from './scripts.js';
import { wireScript } from './wire-scripts.js';

const evaluated = (sourceId: string) => {
  const found = INTERPRETATION_EVALUATION_SET.find(
    (entry) => entry.manifest.sources[0]?.source_id === sourceId
  );
  if (found === undefined) throw new Error(`missing evaluation case ${sourceId}`);
  return found;
};

const wired = (sourceId: string) => {
  const scenario = evaluated(sourceId);
  const script = SCRIPTED_ANSWERS[sourceId];
  if (script === undefined) throw new Error(`missing evaluation script ${sourceId}`);
  return wireScript(scenario, script);
};

describe('real-worker evaluation wire scripts', () => {
  it('uses provider record, scope, and relationship names', () => {
    const restatement = wired('source-verbatim-restatement').statements?.[0];
    expect(restatement).toMatchObject({
      proposed_record: 'requirement',
      intended_scope: { kind: 'project' },
      links: [{ relation: 'exact_restatement' }],
    });
    expect(restatement).not.toHaveProperty('scope');

    const finding = wired('source-repeated-finding').statements?.[0];
    expect(finding).toMatchObject({
      proposed_record: 'claim',
      links: [{ relation: 'exact_restatement' }],
    });
  });

  it('binds artifact intent to the live source instead of a fixture artifact id', () => {
    const statement = wired('source-plain-obligation').statements?.[0];
    expect(statement?.intended_scope).toEqual({ kind: 'current_task' });
  });

  it('names citation faults without carrying v1 offsets', () => {
    const unknown = wired('source-unknown-segment').statements?.[0];
    const outside = wired('source-citation-outside-chunk').statements?.[0];
    expect(unknown).toMatchObject({ citation_fault: 'unknown_segment' });
    expect(outside).toMatchObject({ citation_fault: 'outside_unit' });
    expect(unknown).not.toHaveProperty('unknown_segment');
    expect(outside).not.toHaveProperty('explicit');
  });

  it('keeps an unresolved revision ref so validation sees the broken dependency', () => {
    expect(wired('source-unknown-revision').statements?.[0]?.links).toEqual([
      { ref: 'k9r9', relation: 'supports' },
    ]);
  });

  it('binds a partial fixture answer to its exact fixture unit for live remapping', () => {
    const scenario = evaluated('source-citation-outside-chunk');
    expect(wired('source-citation-outside-chunk').only_unit).toBe(scenario.manifest.unit_id);
    expect(scenario.source_text.length).toBeGreaterThan(scenario.manifest.segments[0].text.length);
  });
});
