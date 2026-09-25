import { createHash } from 'node:crypto';

import { findSecretLocations, REDACTION_MARKER } from '@orcaops/evaluator-protocol/secrets';

import { stripControlChars } from './control-chars.js';
import { canonicalJson } from '../events/canonical-json.js';
import type { InterpretationMappingRun } from '../schema/knowledge-processing-contract.js';

export const INTERPRETATION_MAPPING_VERSION = 'orcaops.interpretation_text_mapping/v1';

export interface PreparedInterpretationText {
  readonly originalSha256: string;
  readonly prepared: string;
  readonly preparedSha256: string;
  readonly mappingVersion: typeof INTERPRETATION_MAPPING_VERSION;
  readonly mappingSha256: string;
  readonly mapping: readonly InterpretationMappingRun[];
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

/** Produce the exact safe text and original/prepared byte mapping supplied to interpretation. */
export function prepareInterpretationText(original: string): PreparedInterpretationText {
  const mapping: InterpretationMappingRun[] = [];
  const prepared: string[] = [];
  let preparedOffset = 0;
  let originalOffset = 0;

  const append = (
    kind: InterpretationMappingRun['kind'],
    originalStart: number,
    originalEnd: number,
    value: string
  ) => {
    const preparedStart = preparedOffset;
    const originalByteStart = originalOffset;
    originalOffset += byteLength(original.slice(originalStart, originalEnd));
    prepared.push(value);
    preparedOffset += byteLength(value);
    mapping.push({
      kind,
      prepared: { start: preparedStart, end: preparedOffset },
      original: {
        start: originalByteStart,
        end: originalOffset,
      },
    });
  };

  const appendCleaned = (start: number, end: number) => {
    let cursor = start;
    let copiedStart = start;
    while (cursor < end) {
      const codePoint = original.codePointAt(cursor)!;
      const width = codePoint > 0xffff ? 2 : 1;
      const character = original.slice(cursor, cursor + width);
      if (stripControlChars(character) !== '') {
        cursor += width;
        continue;
      }
      if (copiedStart < cursor)
        append('copied', copiedStart, cursor, original.slice(copiedStart, cursor));
      append('removed_control', cursor, cursor + width, '');
      cursor += width;
      copiedStart = cursor;
    }
    if (copiedStart < end) append('copied', copiedStart, end, original.slice(copiedStart, end));
  };

  let cursor = 0;
  for (const location of findSecretLocations(original)) {
    appendCleaned(cursor, location.start);
    append('redacted', location.start, location.end, REDACTION_MARKER);
    cursor = location.end;
  }
  appendCleaned(cursor, original.length);

  const preparedText = prepared.join('');
  return {
    originalSha256: sha256(original),
    prepared: preparedText,
    preparedSha256: sha256(preparedText),
    mappingVersion: INTERPRETATION_MAPPING_VERSION,
    mappingSha256: sha256(canonicalJson(mapping)),
    mapping,
  };
}
