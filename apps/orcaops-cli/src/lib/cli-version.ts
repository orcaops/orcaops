import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The CLI's release version, read once from its own package manifest. This is
 * the value every tRPC cloud request carries as `x-orcaops-cli-version` — the
 * identity the cloud's version floors validate — so every SDK
 * client construction site must pass it (directly, or via the process-wide
 * default `buildProgram` installs with `setDefaultCliVersion`). The OAuth
 * discovery/token-exchange calls are a separate unversioned surface.
 */
export const CLI_VERSION = (require('../../package.json') as { version: string }).version;
