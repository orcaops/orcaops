import { RecoveryRefusedError } from '@orcaops/storage';

/**
 * Uniform containment for enumeration surfaces (status, list, digest
 * sibling listings, loose-ends, decisions, search): one rotted artifact
 * degrades its OWN row and never aborts the sweep. The contract:
 *
 *  - only a RecoveryRefusedError degrades — containment/symlink
 *    violations and programming errors propagate;
 *  - the caller renders the row with `unreadable: true`; store-derived
 *    values (anything needing a successful artifact.json or event-log
 *    read) follow their surface's SETTLED refusal vocabulary — null,
 *    row omission, or a settled empty-collection fold (next_actions,
 *    the loose-ends arrays), but never a substituted value ("active",
 *    "no summary"); index-derived facts and index folds are served
 *    verbatim as leads under the marker;
 *  - filters that cannot evaluate a degraded row disclose it instead of
 *    silently dropping it.
 *
 * Resolution surfaces (capture targeting, review scope, attribution
 * pools, ref-GC candidate scans) do NOT use this — they fail closed.
 */
export type EnumerationRead<T> =
  | { kind: 'readable'; value: T }
  | { kind: 'unreadable'; artifact_id: string; reason: string };

export async function readForEnumeration<T>(
  artifactId: string,
  surface: string,
  read: () => Promise<T>
): Promise<EnumerationRead<T>> {
  try {
    return { kind: 'readable', value: await read() };
  } catch (err) {
    if (!(err instanceof RecoveryRefusedError)) throw err;
    process.stderr.write(
      `warning: artifact ${artifactId} is unreadable in ${surface} — ${err.message}\n`
    );
    return { kind: 'unreadable', artifact_id: artifactId, reason: err.message };
  }
}
