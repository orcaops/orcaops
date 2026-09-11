import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getDefaultConfig } from '@orcaops/storage';

import { readEvaluatorsConfig } from '../../src/lib/evaluators-config.js';
import { fixture, grantEvaluatorPack, inventory } from '../helpers/database-history.js';
import { makeAgent } from '../support/test-agent.js';
import { TEST_PACK_ABS_PATH } from '../support/test-helpers.js';

async function configuredRepository() {
  const f = await fixture();
  const config = getDefaultConfig();
  config.llm.tool = 'none';
  config.install.scope = 'project';
  await mkdir(path.join(f.main, '.orcaops'), { recursive: true });
  await writeFile(path.join(f.main, '.orcaops', 'config.json'), JSON.stringify(config));
  const { configDir } = await grantEvaluatorPack(f, {
    packageId: 'test-pack',
    packRoot: TEST_PACK_ABS_PATH,
    enable: { 'test-pack/pass-fixture': true },
  });
  const agent = makeAgent({
    cwd: f.main,
    env: {
      ORCAOPS_ROOT: f.main,
      ORCAOPS_DATA_DIR: f.root,
      ORCAOPS_CONFIG_HOME: configDir,
      ORCAOPS_DISABLE_DRAIN: '1',
    },
  });
  async function run(args: string[]) {
    const result = await agent.runRaw([...args, '--json']);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }
  return { ...f, run };
}

describe('configuration commands and project history', () => {
  it('lists skills and evaluator definitions without changing project history or files', async () => {
    const f = await configuredRepository();
    const before = await inventory(f.temporary);

    expect((await f.run(['eval', 'list'])).evaluators).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: 'test-pack/pass-fixture' })])
    );
    expect(await f.run(['eval', 'show', 'test-pack/pass-fixture'])).toMatchObject({
      evaluator: { ref: 'test-pack/pass-fixture' },
    });
    expect((await f.run(['skills', 'list'])).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'digest' })])
    );

    expect(await inventory(f.temporary)).toEqual(before);
  });

  it('edits configuration when registered history is missing without replacing it', async () => {
    const f = await configuredRepository();
    f.writer.close();
    await rm(f.writer.databasePath);
    const before = await inventory(f.root);

    await f.run(['eval', 'disable', 'test-pack/pass-fixture']);
    expect(
      (await readEvaluatorsConfig(f.main))?.evaluators['test-pack/pass-fixture']?.enabled
    ).toBe(false);
    await f.run(['eval', 'enable', 'test-pack/pass-fixture']);
    expect(
      (await readEvaluatorsConfig(f.main))?.evaluators['test-pack/pass-fixture']?.enabled
    ).toBe(true);
    await f.run(['skills', 'disable', 'digest']);
    expect(
      JSON.parse(await readFile(path.join(f.main, '.orcaops', 'config.json'), 'utf8'))
    ).toMatchObject({
      skills: { enabled: { digest: false } },
    });
    await f.run(['skills', 'enable', 'digest']);
    await f.run(['eval', 'remove-pack', 'test-pack']);
    expect((await readEvaluatorsConfig(f.main))?.packages).toEqual([]);

    await expect(stat(f.writer.databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const relative of ['.orcaops/cache', '.orcaops/artifacts', '.orcaops/tmp/locks'])
      await expect(stat(path.join(f.main, relative))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await inventory(f.root)).toEqual(before);
  });
});
