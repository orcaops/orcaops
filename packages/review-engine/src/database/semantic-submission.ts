import { normalizeSemanticAnchorSubmission } from '../semanticAnchorGenerations.js';
import { SEMANTIC_ANCHOR_PROFILE_V1 } from '../semanticAnchors.js';
import { prepareReviewText } from './records.js';
import { invalid } from './request.js';

export function prepareDatabaseSemanticSubmission(input: {
  bytes: Uint8Array;
  maximumBytes: number;
  secretAllow: readonly string[];
}) {
  if (
    !input ||
    !(input.bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes <= 0 ||
    input.maximumBytes > SEMANTIC_ANCHOR_PROFILE_V1.maximum_submission_bytes
  )
    invalid('Provide exact submission bytes and the retained semantic profile byte ceiling');
  if (input.bytes.byteLength > input.maximumBytes)
    invalid('The semantic submission exceeds its retained profile byte ceiling');
  const retained = prepareReviewText(input);
  return {
    bytes: retained.bytes,
    ...normalizeSemanticAnchorSubmission(retained.text),
  };
}
