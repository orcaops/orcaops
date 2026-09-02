import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defaultConfigDir } from '../credentials/file-store.js';

const ENV_FORCE = 'ORCAOPS_CLOUD_FEATURES';
const ENV_TOKEN = 'ORCAOPS_TOKEN';
const ENV_STORE = 'ORCAOPS_CREDENTIAL_STORE';

/**
 * Presence, not validity: an expired session still counts, because the cloud
 * skills are what tell a user to re-authenticate. Runs on nearly every command,
 * so it must not reach the network — which rules out `isAuthReady`. A false
 * positive costs only a `NOT_CONNECTED` error; the cloud authorizes every
 * request regardless.
 *
 * Takes `env` because the test harness injects it into an ALS frame only, and
 * reading `process.env` would make `--help` depend on the developer's own login.
 */
export function hasCloudCredentials(env: NodeJS.ProcessEnv): boolean {
  const forced = env[ENV_FORCE];
  if (forced === '1') return true;
  if (forced === '0') return false;

  const token = env[ENV_TOKEN];
  if (typeof token === 'string' && token.length > 0) return true;

  // Probing a keyring can raise an OS unlock prompt, which is worse on
  // `--version` than trusting the opt-in that selecting it already signals.
  if (env[ENV_STORE] === 'keyring') return true;

  return hasStoredCredentials(env);
}

/**
 * Not `FileStore`: its read path chmods the store and throws on a malformed
 * file, and this gate must neither mutate the filesystem nor break the commands
 * you reach for when credentials are the broken thing. A schema-invalid entry
 * therefore still counts as present — the session exists, and the cloud command
 * will report the real fault.
 */
function hasStoredCredentials(env: NodeJS.ProcessEnv): boolean {
  try {
    const file = path.join(defaultConfigDir(env), 'credentials.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
