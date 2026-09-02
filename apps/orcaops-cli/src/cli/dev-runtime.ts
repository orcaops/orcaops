import path from 'node:path';

import { assertSafeCloudUrl } from '@orcaops/core';

export interface DevelopmentLaunch {
  cloudBaseUrl: string;
  dataRoot: string;
  cliArgs: string[];
}

export function parseDevelopmentLaunchArgs(argv: readonly string[]): DevelopmentLaunch {
  const separator = argv.indexOf('--');
  if (separator === -1) {
    throw new Error(
      'Usage: orcaops-dev --cloud-url <url> --data-root <path> -- <orcaops arguments>'
    );
  }

  const launcherArgs = argv.slice(0, separator);
  const cliArgs = argv.slice(separator + 1);
  let rawCloudUrl: string | undefined;
  let rawDataRoot: string | undefined;
  for (let index = 0; index < launcherArgs.length; index += 2) {
    const flag = launcherArgs[index];
    const value = launcherArgs[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing required ${flag ?? 'launcher flag'} value`);
    }
    if (flag === '--cloud-url' && rawCloudUrl === undefined) {
      rawCloudUrl = value;
    } else if (flag === '--data-root' && rawDataRoot === undefined) {
      rawDataRoot = value;
    } else {
      throw new Error(`Unknown or duplicate development launcher argument: ${flag}`);
    }
  }

  if (!rawCloudUrl) throw new Error('Missing required --cloud-url value');
  if (!rawDataRoot) throw new Error('Missing required --data-root value');

  const cloudBaseUrl = assertSafeCloudUrl(rawCloudUrl);
  const dataRoot = path.resolve(rawDataRoot);

  return { cloudBaseUrl, dataRoot, cliArgs };
}

export function developmentEnvironment(
  dataRoot: string,
  inherited: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env.ORCAOPS_TOKEN;
  env.XDG_CONFIG_HOME = path.join(dataRoot, 'config');
  env.XDG_DATA_HOME = path.join(dataRoot, 'data');
  env.XDG_CACHE_HOME = path.join(dataRoot, 'cache');
  env.XDG_STATE_HOME = path.join(dataRoot, 'state');
  env.ORCAOPS_CONFIG_HOME = path.join(dataRoot, 'config', 'orcaops');
  env.ORCAOPS_DATA_DIR = path.join(dataRoot, 'data', 'orcaops');
  env.ORCAOPS_CREDENTIAL_STORE = 'file';
  return env;
}
