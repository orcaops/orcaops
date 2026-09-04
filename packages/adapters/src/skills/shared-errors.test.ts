import { describe, expect, it } from 'vitest';

import type { SkillTemplate } from '../types.js';
import { orcaopsCaptureSkill } from './orcaops-capture.js';
import { orcaopsCheckpointSkill } from './orcaops-checkpoint.js';
import { SECRET_IN_PAYLOAD_ERROR_ROW } from './shared-errors.js';

const bodyOf = (skill: SkillTemplate): string =>
  typeof skill.body === 'function' ? skill.body('orcaops') : skill.body;

describe('shared skill error guidance', () => {
  it('renders the same secret-payload instruction in both capture workflows', () => {
    for (const skill of [orcaopsCaptureSkill, orcaopsCheckpointSkill]) {
      expect(bodyOf(skill).split(SECRET_IN_PAYLOAD_ERROR_ROW)).toHaveLength(2);
    }
  });
});
