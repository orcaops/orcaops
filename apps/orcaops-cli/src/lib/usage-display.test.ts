import { describe, expect, it } from 'vitest';

import { sessionDetailKey, type SessionUsageDetail } from '@orcaops/core';
import type { AttributedUsageRow, CodingSessionRow } from '@orcaops/storage';

import {
  artifactUsageJson,
  renderArtifactUsageLines,
  renderCodingSessionsLines,
} from './usage-display.js';

function session(agent: string, id: string): CodingSessionRow {
  return {
    agent,
    session_id: id,
    cumulative_input_tokens: 100,
    cumulative_output_tokens: 50,
    cumulative_cache_creation_input_tokens: 10,
    cumulative_cache_read_input_tokens: 200,
    as_of: '2026-01-01T00:00:00.000Z',
    record_count: 5,
  };
}
const attributed: AttributedUsageRow = {
  input_tokens: 30,
  output_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 40,
};

describe('usage-display', () => {
  it('leads with the exact session total and labels attribution an estimate (never USD)', () => {
    const lines = renderArtifactUsageLines({
      sessions: [session('claude-code', 'sess-1234abcd')],
      attributed,
      hasUsage: true,
    }).join('\n');
    expect(lines).toMatch(/exact session total/);
    expect(lines).toMatch(/in 100 · out 50/); // exact total
    expect(lines).toMatch(/ESTIMATED/);
    expect(lines).toMatch(/in 30 · out 10/); // the estimate
    expect(lines).toMatch(/priced by the cloud/);
    expect(lines).not.toContain('$'); // no local USD figure
  });

  it('renders nothing when there is no usage', () => {
    expect(renderArtifactUsageLines({ sessions: [], attributed, hasUsage: false })).toEqual([]);
    expect(renderCodingSessionsLines([])).toEqual([]);
  });

  it('JSON marks USD priced_by_cloud and keeps the session total exact', () => {
    const j = artifactUsageJson({
      sessions: [session('claude-code', 's1')],
      attributed,
      hasUsage: true,
    });
    expect(j.usd).toBe('priced_by_cloud');
    expect(j.attributed_estimate).toEqual(attributed);
    const sessions = j.session_totals_exact as Array<{ tokens: { input_tokens: number } }>;
    expect(sessions[0].tokens.input_tokens).toBe(100);
  });

  it('surfaces dimensions + rate-class detail when present (show)', () => {
    const detail: SessionUsageDetail = {
      dimensions: { cache_creation_1h_input_tokens: 20 },
      model_breakdown: [
        {
          model: 'claude-opus-4-8',
          speed: 'fast',
          input_tokens: 40,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      ],
    };
    const detailByKey = new Map([[sessionDetailKey('claude-code', 's1'), detail]]);
    const view = {
      sessions: [session('claude-code', 's1')],
      attributed,
      hasUsage: true,
      detailByKey,
    };
    const lines = renderArtifactUsageLines(view).join('\n');
    expect(lines).toMatch(/rate classes:.*claude-opus-4-8 \[fast\]/);
    expect(lines).toMatch(/dimensions:.*cache_creation_1h_input_tokens=20/);
    const j = artifactUsageJson(view);
    const sessions = j.session_totals_exact as Array<{ detail?: SessionUsageDetail }>;
    expect(sessions[0].detail).toEqual(detail);
  });
});
