import { run } from 'effection';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateOneShot as claude } from './claude-code/one-shot.js';
import { evaluateOneShot as codex } from './codex/one-shot.js';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function provider(body: string, failed = false, cutoff = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'orcaops-json-response-'));
  directories.push(directory);
  const script = path.join(directory, 'provider.mjs');
  const binPath = path.join(directory, 'provider');
  await writeFile(
    script,
    `
import { writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) {}
const body = ${JSON.stringify(body)};
const args = process.argv.slice(2);
const output = args.indexOf('--output-last-message');
if (output !== -1) writeFileSync(args[output + 1], body);
else process.stdout.write(JSON.stringify({type:'result', subtype:${JSON.stringify(failed ? 'error_during_execution' : 'success')}, is_error:${failed}, result:body, stop_reason:${JSON.stringify(cutoff ? 'max_tokens' : 'end_turn')}}) + '\\n');
process.exitCode = ${failed ? 1 : 0};
`
  );
  await writeFile(binPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
  return binPath;
}

describe.skipIf(process.platform === 'win32').each([
  ['Claude', claude],
  ['Codex', codex],
] as const)('%s JSON responses', (_name, evaluate) => {
  it('repairs JSON outside background processing and returns exact repair details', async () => {
    const original = '{"values":[1,2,]}';
    const binPath = await provider(original);
    const result = await run(() =>
      evaluate(
        { binPath },
        { prompt: 'Return the supplied answer.', outputSchema: { type: 'object' } }
      )
    );
    expect(result.body).toBe('{"values":[1,2]}');
    expect(result.jsonRepair).toMatchObject({
      originalBody: original,
      edits: [{ offset: 14, removed: ',', inserted: '' }],
    });
    expect(result.error).toBeUndefined();
  });

  it.each(['{"values":[1,2]}', '{"values":[1,'])(
    'leaves valid and unrepairable JSON to the existing caller checks (%s)',
    async (body) => {
      const binPath = await provider(body);
      const result = await run(() =>
        evaluate(
          { binPath },
          { prompt: 'Return the supplied answer.', outputSchema: { type: 'object' } }
        )
      );
      expect(result.body).toBe(body);
      expect(result.jsonRepair).toBeUndefined();
    }
  );

  it('does not change ordinary text responses', async () => {
    const body = '{"values":[1,2,]}';
    const binPath = await provider(body);
    const result = await run(() =>
      evaluate({ binPath }, { prompt: 'Return the supplied answer.' })
    );
    expect(result.body).toBe(body);
    expect(result.jsonRepair).toBeUndefined();
  });

  it('does not repair output from a failed provider', async () => {
    const body = '{"values":[1,2,]}';
    const binPath = await provider(body, true);
    const result = await run(() =>
      evaluate(
        { binPath },
        { prompt: 'Return the supplied answer.', outputSchema: { type: 'object' } }
      )
    );
    expect(result.jsonRepair).toBeUndefined();
    expect(result.body).toBe(body);
  });
});

it.skipIf(process.platform === 'win32')(
  'does not repair an explicitly cut-off Claude answer',
  async () => {
    const body = '{"values":[1,2,]}';
    const binPath = await provider(body, false, true);
    const result = await run(() =>
      claude(
        { binPath },
        { prompt: 'Return the supplied answer.', outputSchema: { type: 'object' } }
      )
    );
    expect(result.body).toBe(body);
    expect(result.jsonRepair).toBeUndefined();
  }
);
