import type { InterpretationManifest } from '../manifest.js';
import { PROPOSAL_LIMITS } from '../proposal.js';
import { PROPOSAL_SCHEMA_VERSION } from '../versions.js';
import type { Proposer } from './harness.js';

const answer = (manifest: InterpretationManifest, statements: unknown[]) =>
  JSON.stringify({
    proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
    manifest_sha256: manifest.manifest_sha256,
    statements,
    corrections: [],
    uncertainties: [],
  });

export const emptyProposer: Proposer = (request) =>
  Promise.resolve({ status: 'answered', body: answer(request.manifest, []) });

/** Deliberately over-promotes every non-empty line so precision checks have a lower bound. */
export const everyLineProposer: Proposer = (request) => {
  const { manifest } = request;
  const statements: unknown[] = [];
  for (const segment of manifest.segments) {
    for (const line of segment.text.split('\n')) {
      const quote = line.trim();
      if (quote.length === 0 || statements.length >= PROPOSAL_LIMITS.statements) continue;
      statements.push({
        source_ref: segment.source_ref,
        wording: quote,
        source_form: 'stated_obligation',
        proposed_record: 'requirement',
        intended_scope: { kind: 'current_task' },
        evidence: [{ source_ref: segment.source_ref, segment_ref: segment.ref, quote }],
        rationale: { kind: 'unknown' },
        alternatives: [],
        links: [],
      });
    }
  }
  return Promise.resolve({ status: 'answered', body: answer(manifest, statements) });
};
