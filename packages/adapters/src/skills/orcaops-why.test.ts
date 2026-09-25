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

  it('reads focused evidence first and does not promote one ambiguous row to best', () => {
    expect(body).toContain(
      'orcaops why src/auth.ts:42 --json --details --candidate <candidate-id> --anchor <inspection.anchor>'
    );
    expect(body).toContain('Find that ID in `results[].id`');
    expect(body).toContain('`knowledge.obligations`');
    expect(body).toContain('`audit.candidates`');
    expect(body).toContain('do not\n  promote `results[0]` to best');
    expect(body).toContain('One returned row does not resolve a tie');
    expect(body).toContain('A non-null best can still carry evidence limitations');
    expect(body).not.toContain('best_result_offset');
    expect(body).not.toContain('`best` stays compact');
  });

  it('separates focused accounts from audit bodies and enrichment', () => {
    expect(body).toContain('A null label is unavailable');
    expect(body).toContain('Missing bodies remain unavailable');
    expect(body).toContain('summary/decisions/uncertainty');
    expect(body).toContain('`enrichment` remains supplemental');
    expect(body).toContain('Cite the underlying\ncommit alongside reconstructed plan decisions');
  });

  it('preserves scope while expanding and distinguishes budgets from presentation', () => {
    for (const option of ['--project', '--scope', '--branch', '--origin', '--touching', '--at'])
      expect(body).toContain(`\`${option}\``);
    expect(body).toContain('orcaops show <artifact_id> --project <project_id> --json');
    expect(body).toContain('`why` has no artifact-ID filter');
    expect(body).toContain('JSON schema 8');
    expect(body).toContain('`--limit 1` limits provenance rows, not rationale retrieval');
    expect(body).toContain('16 KiB by default, 32 KiB with `--view rationale`, and 64 KiB');
    expect(body).toContain('orcaops knowledge show <reference> --project <project_id>');
    expect(body).toContain('background rationale is withheld explicitly');
    expect(body).toContain('`lexical_overlap` is provisional context');
    expect(body).toContain('response reference');
    expect(body).toContain('separate processing bounds');
    expect(body).toContain('An established replacement with `applied: false`');
    expect(body).not.toContain('`knowledge.entries`');
  });

  it('offers bounded alternatives rather than requiring all expansion mechanisms', () => {
    const examples = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap((match) =>
      match[1]!.trim().split('\n')
    );
    expect(examples).toContain('orcaops why src/auth.ts --json --view rationale --limit 5');
    expect(examples.some((command) => command.includes('--all'))).toBe(false);
    expect(body).toContain('a line target does not inherently need details');
    expect(body).toContain('not a mandatory sequence');
    expect(body).toContain('not all returned candidates');
    expect(body).toContain('Stop when');
    expect(body).toContain('`account: null`');
    expect(body).toContain('`account_from`');
    expect(body).toContain('`related_passages`');
    expect(body).toContain('`--section checkpoint-decisions`');
    expect(body).toContain('`--section-offset`');
    expect(body).toContain('not that the question is fully answered');
    expect(body).toContain('`qualification`');
    expect(body).toContain('readable account selector');
    expect(body).toContain('does not replay the earlier why observation');
    expect(body).toContain('selector remains usable after history advances');
    expect(body).toContain('Preview wording is a locator, not complete evidence');
    expect(body).toContain('add another entry point when a material part remains unsupported');
  });

  it('uses evidence coverage guidance for import offers and records the offer', () => {
    expect(body).toContain('Use `diagnostics.seed_guidance` and cached coverage');
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
