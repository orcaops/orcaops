import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { developmentEnvironment, parseDevelopmentLaunchArgs } from './dev-runtime.js';

describe('development launcher', () => {
  it('requires explicit target and data root while preserving CLI arguments', () => {
    const launch = parseDevelopmentLaunchArgs([
      '--cloud-url',
      'http://localhost:3001/',
      '--data-root',
      './tmp/dev-state',
      '--',
      'whoami',
      '--json',
    ]);

    expect(launch).toEqual({
      cloudBaseUrl: 'http://localhost:3001',
      dataRoot: path.resolve('./tmp/dev-state'),
      cliArgs: ['whoami', '--json'],
    });
  });

  it('rejects unsafe, duplicate, and unknown launcher arguments', () => {
    expect(() =>
      parseDevelopmentLaunchArgs([
        '--cloud-url',
        'http://cloud.example',
        '--data-root',
        './state',
        '--',
        'status',
      ])
    ).toThrow(/https/i);
    expect(() =>
      parseDevelopmentLaunchArgs([
        '--cloud-url',
        'https://cloud.example',
        '--cloud-url',
        'https://other.example',
        '--data-root',
        './state',
        '--',
      ])
    ).toThrow(/duplicate/i);
    expect(() =>
      parseDevelopmentLaunchArgs([
        '--cloud-url',
        'https://cloud.example',
        '--data-root',
        './state',
        '--extra',
        'value',
        '--',
      ])
    ).toThrow(/unknown/i);
  });

  it('isolates config, data, cache, state, and credentials from production', () => {
    const root = path.resolve('./tmp/dev-state');
    const env = developmentEnvironment(root, {
      ORCAOPS_TOKEN: 'production-token',
      XDG_CONFIG_HOME: '/production/config',
    });

    expect(env.ORCAOPS_TOKEN).toBeUndefined();
    expect(env.ORCAOPS_CREDENTIAL_STORE).toBe('file');
    expect(env.ORCAOPS_CONFIG_HOME).toBe(path.join(root, 'config', 'orcaops'));
    expect(env.ORCAOPS_DATA_DIR).toBe(path.join(root, 'data', 'orcaops'));
    expect(env.XDG_CACHE_HOME).toBe(path.join(root, 'cache'));
    expect(env.XDG_STATE_HOME).toBe(path.join(root, 'state'));
  });
});
