import { describe, expect, it } from 'vitest';

import { scrubEvaluatorOutput } from '../secrets.js';
import {
  boundEvaluatorFindings,
  EvaluatorFindingLocationSchema,
  EvaluatorFindingsBlockSchema,
  EvaluatorFindingSchema,
  EvaluatorFindingsNoticeSchema,
  EvaluatorFindingsUnreadableSchema,
  EvaluatorRunFindingsSchema,
  FINDING_TRUNCATION_MARKER,
  FINDINGS_BLOCK_SCHEMA,
  FINDINGS_UNREADABLE_SCHEMA,
  MAX_EVALUATOR_FINDINGS,
  MAX_FINDING_DETAIL_CHARS,
  MAX_FINDING_ID_CHARS,
  MAX_FINDING_KEY_CHARS,
  MAX_FINDING_LOCATIONS,
  MAX_FINDING_PATH_CHARS,
  MAX_FINDING_TITLE_CHARS,
  RUN_FINDINGS_SCHEMA,
} from './finding.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);
const ESCAPE = String.fromCodePoint(0x1b);

function findings(count: number): { key: string; title: string }[] {
  return Array.from({ length: count }, (_, i) => ({ key: `k${i}`, title: `finding ${i}` }));
}

describe('EvaluatorFindingSchema', () => {
  it('accepts a finding carrying only a title', () => {
    const out = EvaluatorFindingSchema.parse({
      title: 'The rationale does not explain the choice',
    });
    expect(out.key).toBeUndefined();
    expect(out.detail).toBeUndefined();
    expect(out.locations).toBeUndefined();
    expect(out.conclusion).toBeUndefined();
  });

  it('accepts every optional field at once', () => {
    const out = EvaluatorFindingSchema.parse({
      key: 'criterion/c1',
      title: 'Criterion c1 is satisfied by the delivered tests',
      detail: 'Both named tests exist and assert the behaviour.',
      locations: [
        { kind: 'file', path: 'src/sync.test.ts', start_line: 12, end_line: 40, revision: SHA1 },
        { kind: 'acceptance-criterion', criterion_id: 'c1' },
      ],
      conclusion: 'supported',
    });
    expect(out.conclusion).toBe('supported');
  });

  it('rejects an unknown key', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x', severity: 'block' }).success).toBe(false);
  });

  it('rejects a finding with no title', () => {
    expect(EvaluatorFindingSchema.safeParse({ detail: 'x' }).success).toBe(false);
  });
});

describe('finding title', () => {
  it('accepts a single character', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x' }).success).toBe(true);
  });

  it('accepts a title past the bound, which truncation shortens rather than refuses', () => {
    expect(
      EvaluatorFindingSchema.safeParse({ title: 'x'.repeat(MAX_FINDING_TITLE_CHARS + 1) }).success
    ).toBe(true);
  });

  it('rejects an empty or blank title', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: '' }).success).toBe(false);
    expect(EvaluatorFindingSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('rejects every character that ends a line somewhere', () => {
    for (const code of [0x000a, 0x000d, 0x0000, 0x000b, 0x000c, 0x0085, 0x2028, 0x2029]) {
      const title = `one${String.fromCodePoint(code)}two`;
      expect(EvaluatorFindingSchema.safeParse({ title }).success).toBe(false);
    }
  });

  it('accepts a terminal escape, which the runner scrubs rather than the schema refusing', () => {
    const title = `${ESCAPE}[31mred finding${ESCAPE}[0m`;
    expect(EvaluatorFindingSchema.safeParse({ title }).success).toBe(true);
    expect(scrubEvaluatorOutput(title)).toBe('red finding');
  });
});

describe('finding detail', () => {
  it('accepts a detail past the bound, which truncation shortens rather than refuses', () => {
    expect(
      EvaluatorFindingSchema.safeParse({
        title: 'x',
        detail: 'd'.repeat(MAX_FINDING_DETAIL_CHARS + 1),
      }).success
    ).toBe(true);
  });

  it('rejects an empty detail rather than storing a meaningless one', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x', detail: '' }).success).toBe(false);
  });

  it('accepts newlines in the detail', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x', detail: 'a\nb' }).success).toBe(true);
  });
});

describe('finding key', () => {
  it('accepts a key of dotted, slashed and colon-separated segments', () => {
    for (const key of ['a', 'rule.no-sync', 'src/sync.ts:12', 'R2-D2', 'a_b']) {
      expect(EvaluatorFindingSchema.safeParse({ title: 'x', key }).success).toBe(true);
    }
  });

  it('accepts the full length and rejects one past it, because a shortened key is another key', () => {
    expect(
      EvaluatorFindingSchema.safeParse({ title: 'x', key: 'k'.repeat(MAX_FINDING_KEY_CHARS) })
        .success
    ).toBe(true);
    expect(
      EvaluatorFindingSchema.safeParse({ title: 'x', key: 'k'.repeat(MAX_FINDING_KEY_CHARS + 1) })
        .success
    ).toBe(false);
  });

  it('rejects a path-shaped key that would not survive another machine', () => {
    for (const key of ['/src/sync.ts', 'C:\\src\\a.ts', '~/notes', 'a/../b', 'a/./b', '..']) {
      expect(EvaluatorFindingSchema.safeParse({ title: 'x', key }).success).toBe(false);
    }
  });

  it('rejects an empty key, whitespace, and a leading separator', () => {
    for (const key of ['', ' ', 'a b', '-lead', '.lead', ':lead']) {
      expect(EvaluatorFindingSchema.safeParse({ title: 'x', key }).success).toBe(false);
    }
  });
});

describe('finding locations', () => {
  it('rejects an empty locations array, so "points nowhere" has one spelling', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x', locations: [] }).success).toBe(false);
  });

  it('accepts more locations than the bound, which truncation drops rather than refuses', () => {
    const one = { kind: 'plan-step', step_id: 's1' };
    expect(
      EvaluatorFindingSchema.safeParse({
        title: 'x',
        locations: Array.from({ length: MAX_FINDING_LOCATIONS + 1 }, () => one),
      }).success
    ).toBe(true);
  });

  it('rejects an unknown location kind', () => {
    expect(EvaluatorFindingLocationSchema.safeParse({ kind: 'symbol', name: 'f' }).success).toBe(
      false
    );
  });
});

describe('file location', () => {
  it('accepts a bare path, a single line, and a range', () => {
    expect(EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts' }).success).toBe(
      true
    );
    expect(
      EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts', start_line: 1 })
        .success
    ).toBe(true);
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'file',
        path: 'src/a.ts',
        start_line: 4,
        end_line: 4,
      }).success
    ).toBe(true);
  });

  it('rejects an end line with no start line', () => {
    const res = EvaluatorFindingLocationSchema.safeParse({
      kind: 'file',
      path: 'a.ts',
      end_line: 9,
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(['end_line']);
  });

  it('rejects a range that runs backwards', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'file',
        path: 'a.ts',
        start_line: 9,
        end_line: 8,
      }).success
    ).toBe(false);
  });

  it('rejects a non-positive or fractional line number', () => {
    for (const start_line of [0, -1, 1.5]) {
      expect(
        EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts', start_line }).success
      ).toBe(false);
    }
  });

  it('rejects a path that reaches outside the repository', () => {
    for (const path of [
      '/etc/passwd',
      'C:/src/a.ts',
      'src\\a.ts',
      '~/.ssh/id_rsa',
      '~',
      '../outside.ts',
      'src/../a.ts',
      'src/./a.ts',
      'src/.../a.ts',
      'src//a.ts',
      'src/',
      '',
    ]) {
      expect(EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path }).success).toBe(false);
    }
  });

  it('rejects a path carrying a control character', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'file',
        path: `src/${String.fromCodePoint(0x07)}a.ts`,
      }).success
    ).toBe(false);
  });

  it('accepts a path at the length bound and rejects one past it', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'file',
        path: 'a'.repeat(MAX_FINDING_PATH_CHARS),
      }).success
    ).toBe(true);
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'file',
        path: 'a'.repeat(MAX_FINDING_PATH_CHARS + 1),
      }).success
    ).toBe(false);
  });

  it('accepts a full git object id as the revision', () => {
    for (const revision of [SHA1, SHA256]) {
      expect(
        EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts', revision }).success
      ).toBe(true);
    }
  });

  it('rejects a revision that is not an identified one', () => {
    for (const revision of ['HEAD', 'main', 'working tree', '', 'a'.repeat(7), 'A'.repeat(40)]) {
      expect(
        EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts', revision }).success
      ).toBe(false);
    }
  });

  it('rejects an unknown key', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({ kind: 'file', path: 'a.ts', column: 3 }).success
    ).toBe(false);
  });
});

describe('capture and knowledge locations', () => {
  it('accepts a plan step, an acceptance criterion, a requirement and a decision', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({ kind: 'plan-step', step_id: 's1' }).success
    ).toBe(true);
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'acceptance-criterion',
        criterion_id: 'c1',
      }).success
    ).toBe(true);
    expect(
      EvaluatorFindingLocationSchema.safeParse({ kind: 'requirement', revision_id: 'r1' }).success
    ).toBe(true);
    expect(
      EvaluatorFindingLocationSchema.safeParse({ kind: 'decision', revision_id: 'd1' }).success
    ).toBe(true);
  });

  it('rejects a criterion location that also names a step', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'acceptance-criterion',
        criterion_id: 'c1',
        step_id: 's1',
      }).success
    ).toBe(false);
  });

  it('rejects a blank or whitespace-only id', () => {
    for (const step_id of ['', ' ', '\t', '  \n ']) {
      expect(EvaluatorFindingLocationSchema.safeParse({ kind: 'plan-step', step_id }).success).toBe(
        false
      );
    }
  });

  it('rejects an id carrying a control character or past the length bound', () => {
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'plan-step',
        step_id: `s${String.fromCodePoint(0x00)}1`,
      }).success
    ).toBe(false);
    expect(
      EvaluatorFindingLocationSchema.safeParse({
        kind: 'plan-step',
        step_id: 's'.repeat(MAX_FINDING_ID_CHARS + 1),
      }).success
    ).toBe(false);
  });
});

describe('finding conclusion', () => {
  it('accepts a conclusion on a finding that names an expectation', () => {
    for (const location of [
      { kind: 'plan-step', step_id: 's1' },
      { kind: 'acceptance-criterion', criterion_id: 'c1' },
      { kind: 'requirement', revision_id: 'r1' },
      { kind: 'decision', revision_id: 'd1' },
    ]) {
      const res = EvaluatorFindingSchema.safeParse({
        title: 'x',
        locations: [location],
        conclusion: 'contradicted',
      });
      expect(res.success).toBe(true);
    }
  });

  it('refuses a conclusion on a finding that names only a file', () => {
    const res = EvaluatorFindingSchema.safeParse({
      title: 'x',
      locations: [{ kind: 'file', path: 'a.ts' }],
      conclusion: 'supported',
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(['conclusion']);
  });

  it('refuses a conclusion on a finding that points nowhere', () => {
    expect(EvaluatorFindingSchema.safeParse({ title: 'x', conclusion: 'unresolved' }).success).toBe(
      false
    );
  });

  it('accepts a file location beside the expectation it concludes about', () => {
    expect(
      EvaluatorFindingSchema.safeParse({
        title: 'x',
        locations: [
          { kind: 'file', path: 'a.ts' },
          { kind: 'plan-step', step_id: 's1' },
        ],
        conclusion: 'supported',
      }).success
    ).toBe(true);
  });

  it('refuses a conclusion outside the closed vocabulary', () => {
    for (const conclusion of ['not-assessed', 'met', 'pass', '']) {
      expect(
        EvaluatorFindingSchema.safeParse({
          title: 'x',
          locations: [{ kind: 'plan-step', step_id: 's1' }],
          conclusion,
        }).success
      ).toBe(false);
    }
  });
});

describe('boundEvaluatorFindings', () => {
  it('returns the findings unchanged and no notice when nothing is over a bound', () => {
    const out = boundEvaluatorFindings(findings(3));
    expect(out.findings).toHaveLength(3);
    expect(out.notice).toBeUndefined();
  });

  it('keeps the maximum number of findings and reports the rest as dropped', () => {
    const out = boundEvaluatorFindings(findings(MAX_EVALUATOR_FINDINGS + 1));
    expect(out.findings).toHaveLength(MAX_EVALUATOR_FINDINGS);
    expect(out.notice?.findings_dropped).toBe(1);
  });

  it('shortens an over-long title and marks it', () => {
    const out = boundEvaluatorFindings([{ title: 'x'.repeat(MAX_FINDING_TITLE_CHARS + 50) }]);
    expect(out.findings[0].title).toHaveLength(MAX_FINDING_TITLE_CHARS);
    expect(out.findings[0].title.endsWith(FINDING_TRUNCATION_MARKER)).toBe(true);
    expect(out.notice?.titles_shortened).toBe(1);
  });

  it('shortens an over-long detail and marks it', () => {
    const out = boundEvaluatorFindings([
      { title: 'x', detail: 'd'.repeat(MAX_FINDING_DETAIL_CHARS + 1) },
    ]);
    expect(out.findings[0].detail).toHaveLength(MAX_FINDING_DETAIL_CHARS);
    expect(out.findings[0].detail?.endsWith(FINDING_TRUNCATION_MARKER)).toBe(true);
    expect(out.notice?.details_shortened).toBe(1);
  });

  it('drops locations past the bound and counts them', () => {
    const out = boundEvaluatorFindings([
      {
        title: 'x',
        locations: Array.from({ length: MAX_FINDING_LOCATIONS + 3 }, () => ({
          kind: 'plan-step' as const,
          step_id: 's1',
        })),
      },
    ]);
    expect(out.findings[0].locations).toHaveLength(MAX_FINDING_LOCATIONS);
    expect(out.notice?.locations_dropped).toBe(3);
  });

  it('does not mutate the findings it was given', () => {
    const original = [{ title: 'x'.repeat(MAX_FINDING_TITLE_CHARS + 1) }];
    boundEvaluatorFindings(original);
    expect(original[0].title).toHaveLength(MAX_FINDING_TITLE_CHARS + 1);
  });

  it('produces findings the schema still accepts', () => {
    const out = boundEvaluatorFindings([
      { title: 'x'.repeat(MAX_FINDING_TITLE_CHARS + 1), detail: 'd'.repeat(9000) },
    ]);
    expect(EvaluatorFindingSchema.safeParse(out.findings[0]).success).toBe(true);
  });

  it('retains the first bounded expectation locations without mutating their original order', () => {
    const locations = [
      { kind: 'file' as const, path: 'src/first.ts' },
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: 'plan-step' as const,
        step_id: `step-${index}`,
      })),
    ];
    const finding = { title: 'Steps supported', conclusion: 'supported' as const, locations };
    const before = structuredClone(finding);
    const result = boundEvaluatorFindings([finding]);
    expect(result.findings[0].locations).toEqual(locations.slice(1, 11));
    expect(result.notice?.locations_dropped).toBe(3);
    expect(EvaluatorFindingSchema.safeParse(result.findings[0]).success).toBe(true);
    expect(finding).toEqual(before);
    const withoutConclusion = boundEvaluatorFindings([{ title: finding.title, locations }]);
    expect(withoutConclusion.findings[0].locations).toEqual(locations.slice(0, 10));
  });
});

describe('EvaluatorFindingsNoticeSchema', () => {
  it('accepts a notice that records something cut', () => {
    expect(
      EvaluatorFindingsNoticeSchema.safeParse({
        findings_dropped: 1,
        locations_dropped: 0,
        titles_shortened: 0,
        details_shortened: 0,
      }).success
    ).toBe(true);
  });

  it('refuses a notice that records nothing, so "nothing was cut" has one spelling', () => {
    expect(
      EvaluatorFindingsNoticeSchema.safeParse({
        findings_dropped: 0,
        locations_dropped: 0,
        titles_shortened: 0,
        details_shortened: 0,
      }).success
    ).toBe(false);
  });
});

describe('EvaluatorFindingsBlockSchema', () => {
  it('accepts an explicitly empty findings array', () => {
    expect(
      EvaluatorFindingsBlockSchema.parse({ schema: FINDINGS_BLOCK_SCHEMA, findings: [] }).findings
    ).toEqual([]);
  });

  it('accepts more findings than the bound, which truncation drops rather than refuses', () => {
    expect(
      EvaluatorFindingsBlockSchema.safeParse({
        schema: FINDINGS_BLOCK_SCHEMA,
        findings: findings(MAX_EVALUATOR_FINDINGS + 1),
      }).success
    ).toBe(true);
  });

  it('rejects two findings claiming the same key', () => {
    const res = EvaluatorFindingsBlockSchema.safeParse({
      schema: FINDINGS_BLOCK_SCHEMA,
      findings: [
        { key: 'same', title: 'first' },
        { key: 'same', title: 'second' },
      ],
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(['findings', 1, 'key']);
  });

  it('accepts several findings that name no key', () => {
    expect(
      EvaluatorFindingsBlockSchema.safeParse({
        schema: FINDINGS_BLOCK_SCHEMA,
        findings: [{ title: 'first' }, { title: 'second' }],
      }).success
    ).toBe(true);
  });

  it('rejects a wrong literal and an unknown key', () => {
    expect(
      EvaluatorFindingsBlockSchema.safeParse({
        schema: 'orcaops.evaluator_findings/v2',
        findings: [],
      }).success
    ).toBe(false);
    expect(
      EvaluatorFindingsBlockSchema.safeParse({
        schema: FINDINGS_BLOCK_SCHEMA,
        findings: [],
        run_id: 'r1',
      }).success
    ).toBe(false);
  });
});

describe('EvaluatorRunFindingsSchema', () => {
  const run_id = '019f338d-4911-7fba-a93f-8cfd7e70193e';

  it('accepts a run with findings and no notice', () => {
    const out = EvaluatorRunFindingsSchema.parse({
      schema: RUN_FINDINGS_SCHEMA,
      run_id,
      findings: [{ key: 'k', title: 'something' }],
    });
    expect(out.notice).toBeUndefined();
  });

  it('carries the notice when something was cut', () => {
    const out = EvaluatorRunFindingsSchema.parse({
      schema: RUN_FINDINGS_SCHEMA,
      run_id,
      findings: [{ title: 'something' }],
      notice: {
        findings_dropped: 4,
        locations_dropped: 0,
        titles_shortened: 1,
        details_shortened: 0,
      },
    });
    expect(out.notice?.findings_dropped).toBe(4);
  });

  it('rejects a record asserting zero findings', () => {
    expect(
      EvaluatorRunFindingsSchema.safeParse({ schema: RUN_FINDINGS_SCHEMA, run_id, findings: [] })
        .success
    ).toBe(false);
  });

  it('requires a run id that is not missing or blank', () => {
    for (const candidate of [undefined, '', '   ']) {
      expect(
        EvaluatorRunFindingsSchema.safeParse({
          schema: RUN_FINDINGS_SCHEMA,
          ...(candidate === undefined ? {} : { run_id: candidate }),
          findings: [{ title: 'x' }],
        }).success
      ).toBe(false);
    }
  });

  it('rejects the fields the run event already owns', () => {
    expect(
      EvaluatorRunFindingsSchema.safeParse({
        schema: RUN_FINDINGS_SCHEMA,
        run_id,
        artifact_id: 'a1',
        findings: [{ title: 'x' }],
      }).success
    ).toBe(false);
  });

  it('rejects the findings-block literal, which is a different shape', () => {
    expect(
      EvaluatorRunFindingsSchema.safeParse({
        schema: FINDINGS_BLOCK_SCHEMA,
        run_id,
        findings: [{ title: 'x' }],
      }).success
    ).toBe(false);
  });

  it('rejects duplicate keys', () => {
    expect(
      EvaluatorRunFindingsSchema.safeParse({
        schema: RUN_FINDINGS_SCHEMA,
        run_id,
        findings: [
          { key: 'same', title: 'a' },
          { key: 'same', title: 'b' },
        ],
      }).success
    ).toBe(false);
  });
});

describe('EvaluatorFindingsUnreadableSchema', () => {
  const base = {
    schema: FINDINGS_UNREADABLE_SCHEMA,
    run_id: '019f338d-4911-7fba-a93f-8cfd7e70193e',
    source: 'markdown-block',
    detail: 'block was opened and never closed',
  };

  it('accepts a record naming where the findings came from and why they failed', () => {
    expect(EvaluatorFindingsUnreadableSchema.parse(base).source).toBe('markdown-block');
    expect(
      EvaluatorFindingsUnreadableSchema.safeParse({ ...base, source: 'envelope' }).success
    ).toBe(true);
  });

  it('carries no findings and no verdict', () => {
    expect(EvaluatorFindingsUnreadableSchema.safeParse({ ...base, findings: [] }).success).toBe(
      false
    );
    expect(EvaluatorFindingsUnreadableSchema.safeParse({ ...base, verdict: 'pass' }).success).toBe(
      false
    );
  });

  it('rejects a source outside the closed pair', () => {
    expect(EvaluatorFindingsUnreadableSchema.safeParse({ ...base, source: 'raw' }).success).toBe(
      false
    );
  });

  it('requires a detail within the bound and a run id that is not blank', () => {
    expect(EvaluatorFindingsUnreadableSchema.safeParse({ ...base, detail: '' }).success).toBe(
      false
    );
    expect(
      EvaluatorFindingsUnreadableSchema.safeParse({
        ...base,
        detail: 'd'.repeat(MAX_FINDING_DETAIL_CHARS + 1),
      }).success
    ).toBe(false);
    expect(EvaluatorFindingsUnreadableSchema.safeParse({ ...base, run_id: '  ' }).success).toBe(
      false
    );
  });
});
