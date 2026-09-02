import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { extractStamp } from '../renderers.js';
import { opencodeSessionPluginPath, renderOpencodeSessionPlugin } from './opencode-plugin.js';

describe('opencode session plugin renderer', () => {
  it('stamps a JS block comment the shared stamp regexes can parse', () => {
    const content = renderOpencodeSessionPlugin({ generatedBy: '9.9.9' });
    // The stamp must be readable by the SAME extractors as markdown artifacts
    // — that is what makes the plugin drift-trackable with zero new machinery.
    const stamp = extractStamp(content);
    expect(stamp.version).toBe('9.9.9');
    expect(stamp.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // …and it must be a syntactically valid JS block comment.
    expect(content.startsWith('/* generatedBy: "orcaops@9.9.9"')).toBe(true);
    expect(content).toMatch(/\n {2}contentHash: "[0-9a-f]{12}" \*\//);
  });

  it('renders deterministically and one-shots via chat.message', () => {
    const a = renderOpencodeSessionPlugin({ generatedBy: '1.0.0' });
    expect(renderOpencodeSessionPlugin({ generatedBy: '1.0.0' })).toBe(a);
    expect(a).toContain("'chat.message'");
    expect(a).toContain('orcaops hook session-start --agent opencode');
    expect(a).toContain('seenSessions');
  });

  it('places the plugin under the overlay-declared dir with the naming prefix', () => {
    expect(opencodeSessionPluginPath()).toBe('.opencode/plugins/orcaops-session-context.js');
    expect(opencodeSessionPluginPath('oo')).toBe('.opencode/plugins/oo-session-context.js');
  });

  it('loads and stays silent when the factory receives no argument', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'orcaops-opencode-plugin-'));
    const pluginPath = path.join(dir, 'session-context.mjs');
    await writeFile(pluginPath, renderOpencodeSessionPlugin({ generatedBy: '1.0.0' }), 'utf8');
    const plugin = (await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`)) as {
      OrcaopsSessionContext: () => Promise<{
        'chat.message': (
          input: unknown,
          output: { message: { sessionID: string }; parts: unknown[] }
        ) => Promise<void>;
      }>;
    };
    const createPlugin = plugin.OrcaopsSessionContext;
    const hooks = await createPlugin();
    const output = { message: { sessionID: 'argless' }, parts: [] };
    await expect(hooks['chat.message']({}, output)).resolves.toBeUndefined();
    expect(output.parts).toEqual([]);
  });
});
