import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { COMMAND_TEMPLATES } from './commands/index.js';
import { listToolAdapters } from './registry.js';
import { opencodeSessionPluginPath } from './session-hooks/opencode-plugin.js';
import { SKILL_TEMPLATES } from './skills/index.js';

const contract: { checkout_presence: string[] } = JSON.parse(
  await readFile(
    new URL('../../test-harness/tests/fixtures/bootstrap-locations.json', import.meta.url),
    'utf8'
  )
);
const frozenLocations = new Set(contract.checkout_presence);

describe('frozen bootstrap presence contract', () => {
  it.each(listToolAdapters())('covers every current $id skill and command path', (adapter) => {
    for (const skill of SKILL_TEMPLATES) {
      const location = adapter.skills?.filePath(skill.id);
      if (location) expect(frozenLocations, `${adapter.id} skill ${skill.id}`).toContain(location);
    }
    for (const command of COMMAND_TEMPLATES) {
      const location = adapter.commands?.filePath(command.id);
      if (location)
        expect(frozenLocations, `${adapter.id} command ${command.id}`).toContain(location);
    }
  });

  it('covers the generated session plugin path', () => {
    expect(frozenLocations).toContain(opencodeSessionPluginPath());
  });
});
