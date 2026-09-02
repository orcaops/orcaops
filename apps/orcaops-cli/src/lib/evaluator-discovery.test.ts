import { describe, expect, it } from 'vitest';

import { EvaluatorDiscoveryError } from '@orcaops/evaluator-runner';

import {
  errorsAffecting,
  evaluatorNotFound,
  untrustworthyCapabilities,
} from './evaluator-discovery.js';
import { ErrorCodes } from '../io/errors.js';

function discoveryError(packageId: string | undefined, file: string): EvaluatorDiscoveryError {
  const err = new EvaluatorDiscoveryError({ source_path: `/repo/${file}`, message: 'broke' });
  if (packageId !== undefined) err.package_id = packageId;
  return err;
}

describe('errorsAffecting', () => {
  it('keeps the named pack and everything unattributable', () => {
    const errors = [
      discoveryError('core', 'core/a.eval.yaml'),
      discoveryError('local', 'local/b.eval.yaml'),
      // Config-level failures precede packs and could hide any of them.
      discoveryError(undefined, '.orcaops/evaluators.yaml'),
    ];
    expect(errorsAffecting('core', errors).map((e) => e.source_path)).toEqual([
      '/repo/core/a.eval.yaml',
      '/repo/.orcaops/evaluators.yaml',
    ]);
  });

  it('keeps only unattributable errors for an unknown pack', () => {
    const errors = [discoveryError('local', 'local/b.eval.yaml'), discoveryError(undefined, 'x')];
    expect(errorsAffecting('nope', errors)).toHaveLength(1);
  });
});

describe('evaluatorNotFound', () => {
  it('says NOT_FOUND when nothing that failed could hide the ref', () => {
    // The defect this replaces: an unrelated pack's breakage made every
    // missing ref look like it might exist, sending users to hunt for a
    // correctly-spelled ref while the broken pack went unmentioned.
    const err = evaluatorNotFound('core/typo', [discoveryError('local', 'local/b.eval.yaml')]);
    expect(err.code).toBe(ErrorCodes.EVALUATOR_NOT_FOUND);
  });

  it('says DISCOVERY_FAILED when the ref own pack failed to load', () => {
    const err = evaluatorNotFound('core/typo', [discoveryError('core', 'core/a.eval.yaml')]);
    expect(err.code).toBe(ErrorCodes.EVALUATOR_DISCOVERY_FAILED);
    expect(err.message).toContain('orcaops doctor');
  });

  it('says DISCOVERY_FAILED on an unattributable failure', () => {
    const err = evaluatorNotFound('core/typo', [discoveryError(undefined, 'evaluators.yaml')]);
    expect(err.code).toBe(ErrorCodes.EVALUATOR_DISCOVERY_FAILED);
  });

  it('counts distinct packs, not per-spec errors', () => {
    // Two broken specs in one pack is one broken pack.
    const err = evaluatorNotFound('core/typo', [
      discoveryError('core', 'core/a.eval.yaml'),
      discoveryError('core', 'core/b.eval.yaml'),
    ]);
    expect(err.message).toContain('2 problem(s) in 1 pack(s)');
  });

  it('says NOT_FOUND for a bare ref with no pack prefix', () => {
    const err = evaluatorNotFound('typo', [discoveryError('core', 'core/a.eval.yaml')]);
    expect(err.code).toBe(ErrorCodes.EVALUATOR_NOT_FOUND);
  });
});

describe('untrustworthyCapabilities', () => {
  it('returns null when only other packs failed', () => {
    expect(untrustworthyCapabilities('core', [discoveryError('local', 'local/b.eval.yaml')])).toBe(
      null
    );
  });

  it('refuses when the target pack itself failed', () => {
    const err = untrustworthyCapabilities('core', [discoveryError('core', 'core/a.eval.yaml')]);
    expect(err?.code).toBe(ErrorCodes.EVALUATOR_DISCOVERY_FAILED);
    expect(err?.message).toContain('narrower than the pack requires');
  });

  it('refuses on an unattributable failure', () => {
    expect(untrustworthyCapabilities('core', [discoveryError(undefined, 'x')])).not.toBe(null);
  });

  it('returns null when nothing failed', () => {
    expect(untrustworthyCapabilities('core', [])).toBe(null);
  });
});
