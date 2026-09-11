import { describe, expect, it } from 'vitest';

import { orcaopsWhySkill } from './orcaops-why.js';

function render(prefix: string): string {
  const { body } = orcaopsWhySkill;
  return typeof body === 'function' ? body(prefix) : body;
}

describe('orcaops-why guidance', () => {
  const body = render('orcaops');

  it('routes ownership, symbol, and subsystem questions through captured evidence', () => {
    expect(orcaopsWhySkill.description).toContain('who owns this code?');
    expect(orcaopsWhySkill.description).toContain('Invoke before reading the code');
    expect(body).toContain('**Named symbol:**');
    expect(body).toContain('**Subsystem:**');
    expect(body).toContain('ranked by applicability, not newest-first');
    expect(body).toContain('corroborate against code, tests, or commits');
  });

  it('reads rich best directly and does not promote one ambiguous row to best', () => {
    expect(body).toContain('orcaops why src/auth.ts:42 --json --details --limit 1');
    expect(body).toContain('Read rich `best` when it is present');
    expect(body).toContain('do not\n  promote `results[0]` to best');
    expect(body).toContain('One returned row does not resolve a tie');
    expect(body).toContain('A non-null best can still carry evidence\n  limitations');
    expect(body).not.toContain('best_result_offset');
    expect(body).not.toContain('`best` stays compact');
  });

  it('separates historical labels and evidence counts from narrative and enrichment', () => {
    expect(body).toContain('`label` comes only from `plan_support.plan`');
    expect(body).toContain('Null means the\nbody is unavailable; zero means available but empty');
    expect(body).toContain('`best.checkpoint.summary`, `.decisions`, and `.uncertainty`');
    expect(body).toContain('`enrichment` is separately marked supplemental');
    expect(body).toContain('Cite the underlying\ncommit alongside reconstructed plan decisions');
  });

  it('preserves scope while expanding and distinguishes budgets from presentation', () => {
    for (const option of ['--project', '--scope', '--branch', '--origin', '--touching', '--at'])
      expect(body).toContain(`\`${option}\``);
    expect(body).toContain('orcaops show <artifact_id> --project <project_id> --json');
    expect(body).toContain('`why` has no artifact-ID filter');
    expect(body).toContain(
      '`--limit 1` limits result rows, not narrative bytes or shared diagnostics'
    );
    expect(body).toContain('`--details` without `--json` adds nothing');
    expect(body).toContain('500 candidate artifacts');
    expect(body).toContain('500 overlap-support artifacts');
    expect(body).toContain('`detail_omissions` (presentation)');
    expect(body).toContain('`candidate_selection` (processing budgets)');
    expect(body).toContain('it is not a historical retrieval token');
  });

  it('uses evidence coverage guidance for import offers and records the offer', () => {
    expect(body).toContain('Use `seed_guidance` and cached coverage');
    expect(body).toContain('`orcaops-seed`');
    expect(body).toContain('orcaops seed --commit <sha>');
    expect(body).toContain('orcaops seed --path <dir>');
    expect(body).toContain('orcaops seed status --offered <area>');
    expect(body).toContain("orcaops seed status --offer-again <area>` is the user's call");
  });

  it('renders cross-references under a custom prefix while retaining CLI verbs', () => {
    const prefixed = render('oo');
    expect(prefixed).toContain('`oo-seed`');
    expect(prefixed).toContain('`oo-seed-discovery`');
    expect(prefixed).toContain('`oo-timetravel`');
    expect(prefixed).toContain('orcaops seed status --offered <area>');
  });
});
