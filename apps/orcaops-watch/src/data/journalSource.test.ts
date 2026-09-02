import { describe, expect, it } from 'vitest';

import { parseAppendRejection, parseJournalResponse, parseLedger } from './journalSource';

describe('Watch v2 journal boundary', () => {
  it('translates snake_case generation once and retains all v2 replay state', () => {
    const ledger = parseLedger(
      JSON.stringify({
        sections: [],
        findings: [],
        uncertainties: [],
        coverage: [
          {
            threadKey: 'sec_a',
            coveredRows: [],
            coveredRowsDigest: 'digest',
            ts: '2026-07-12T00:00:00Z',
            fullCoverageRows: null,
            fullCoverageRowsDigest: null,
            fullCoverageTs: null,
          },
        ],
        prompts: [],
        unassigned: { gapRows: [], gapRowsDigest: null, ambiguousHunkKeys: ['hunk_a'] },
        lifecycle: { state: 'OPEN', stale: false, current: null, history: [] },
        ledger_generation: 'generation-a',
      })
    );
    expect(ledger.ledgerGeneration).toBe('generation-a');
    expect(ledger.coverage[0]?.threadKey).toBe('sec_a');
    expect(ledger.unassigned.ambiguousHunkKeys).toEqual(['hunk_a']);
    expect(ledger.lifecycle.state).toBe('OPEN');
    expect(ledger).not.toHaveProperty('ledger_generation');
  });

  it('rejects a ledger payload missing the v2 replay fields instead of fabricating defaults', () => {
    expect(() =>
      parseLedger(JSON.stringify({ sections: [], findings: [], uncertainties: [] }))
    ).toThrow('unexpected review ledger shape');
  });

  it('accepts only the engine-owned discriminated append rejection wire', () => {
    expect(
      parseAppendRejection(
        JSON.stringify({ ok: false, code: 'STALE_LEDGER', message: 'refresh and retry' })
      )
    ).toEqual({ ok: false, code: 'STALE_LEDGER', message: 'refresh and retry' });
    expect(parseAppendRejection('stale ledger generation; refresh and retry')).toBeNull();
    expect(
      parseAppendRejection(
        JSON.stringify({ ok: false, code: 'INVENTED_CODE', message: 'looks plausible' })
      )
    ).toBeNull();
  });

  it('parses successful archive warnings without adding them to the ledger', () => {
    const response = parseJournalResponse(
      JSON.stringify({
        sections: [],
        findings: [],
        uncertainties: [],
        coverage: [],
        prompts: [],
        unassigned: { gapRows: [], gapRowsDigest: null, ambiguousHunkKeys: [] },
        lifecycle: { state: 'OPEN', stale: false, current: null, history: [] },
        ledger_generation: 'generation-a',
        warnings: [
          {
            code: 'REVIEW_ARCHIVE_WRITE_FAILED',
            message: 'hot append succeeded; mirror unavailable',
          },
        ],
      })
    );

    expect(response.warnings).toEqual([
      {
        code: 'REVIEW_ARCHIVE_WRITE_FAILED',
        message: 'hot append succeeded; mirror unavailable',
      },
    ]);
    expect(response.ledger).not.toHaveProperty('warnings');
  });

  it('retains typed rejections with archive warnings as one document', () => {
    expect(
      parseAppendRejection(
        JSON.stringify({
          ok: false,
          code: 'STALE_LEDGER',
          message: 'refresh and retry',
          warnings: [
            {
              code: 'REVIEW_ARCHIVE_SETUP_FAILED',
              message: 'archive unavailable',
            },
          ],
        })
      )
    ).toEqual({
      ok: false,
      code: 'STALE_LEDGER',
      message: 'refresh and retry',
      warnings: [
        {
          code: 'REVIEW_ARCHIVE_SETUP_FAILED',
          message: 'archive unavailable',
        },
      ],
    });
  });

  it('rejects malformed warning fields at the sidecar boundary', () => {
    expect(
      parseAppendRejection(
        JSON.stringify({
          ok: false,
          code: 'STALE_LEDGER',
          message: 'refresh and retry',
          warnings: [{ code: 'INVENTED_WARNING', message: 'nope' }],
        })
      )
    ).toBeNull();
  });
});
