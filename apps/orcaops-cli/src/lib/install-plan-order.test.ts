import { describe, expect, it } from 'vitest';

import { INSTALL_MANIFEST_REL, LOCAL_MANIFEST_REL } from './install-manifest.js';
import { publishInstallManifestsLast } from './install-plan.js';
import { type PlannedMutation, writeMutation } from './mutations.js';

describe('install manifest publication order', () => {
  it('publishes the local manifest and then committed ownership after every other mutation', () => {
    const root = '/repo';
    const mutation = (relative: string): PlannedMutation =>
      writeMutation(root, relative, relative, null, true);
    const generated = mutation('.agents/skills/orcaops/SKILL.md');
    const install = mutation(INSTALL_MANIFEST_REL);
    const config = mutation('.orcaops/config.json');
    const local = mutation(LOCAL_MANIFEST_REL);
    const gitignore = mutation('.gitignore');

    expect(
      publishInstallManifestsLast([generated, install, config, local, gitignore]).map(
        (entry) => entry.path
      )
    ).toEqual([generated.path, config.path, gitignore.path, local.path, install.path]);
  });
});
