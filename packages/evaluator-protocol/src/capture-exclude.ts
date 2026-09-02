/**
 * Paths excluded from capture snapshot trees, and denied to sandboxed
 * evaluators, with no configuration at all.
 *
 * Lives here for the same reason `./secret-corpus` does: evaluator-protocol is
 * already a dependency of both consumers — storage, which keeps these out of
 * snapshot trees, and llm, which denies them to an evaluator subprocess — and
 * depends on neither, so sharing adds no edge and cannot create a cycle. Two
 * copies of a credential-path list would drift, and the drift would be silent
 * in exactly the direction that matters.
 *
 * Credential-bearing filenames rather than a heuristic: an entry earns its
 * place by being a file whose whole purpose is to hold a secret, so a false
 * positive costs a file nobody wanted captured anyway.
 *
 * `**\/.env.*` matches `.env.example` too. That is intended — a template is
 * trivially re-derivable and its absence from a snapshot tree costs nothing —
 * but it is the most likely surprise, so it is documented rather than tuned.
 */
export const DEFAULT_CAPTURE_EXCLUDE: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/*.jks',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.netrc',
  '**/.pgpass',
  '**/.git-credentials',
  '**/credentials.json',
  '**/service-account*.json',
  '**/serviceAccount*.json',
];
