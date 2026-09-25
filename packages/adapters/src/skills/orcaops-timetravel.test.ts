import { describe, expect, it } from 'vitest';

import { orcaopsTimetravelSkill } from './orcaops-timetravel.js';

function render(prefix: string): string {
  const { body } = orcaopsTimetravelSkill;
  return typeof body === 'function' ? body(prefix) : body;
}

describe('orcaops-timetravel guidance', () => {
  const body = render('orcaops');

  it('reads the abandon reason from the field show actually emits', () => {
    expect(body).toContain('`artifact.checkpoints[]`');
    expect(body).toContain('`status: "abandoned"`');
    expect(body).toContain('`reason`');
    expect(body).not.toContain('abandon_reason');
  });
});
