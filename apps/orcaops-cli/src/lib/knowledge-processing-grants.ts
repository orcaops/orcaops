import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isatty } from 'node:tty';

import { defaultConfigDir } from '@orcaops/core';

import {
  describeProcessingGrants,
  PROCESSING_CONSENT_CAPABILITY,
  type ProcessingDisclosure,
  type ProcessingGrant,
  ProcessingGrantSchema,
  type ProcessingGrantsFile,
  ProcessingGrantsFileSchema,
  type ProcessingGrantStatus,
  type ProcessingGrantStoreProblem,
  ProcessingGrantTermsSchema,
  type ProcessingProvider,
  type ProcessingSourceScope,
} from './knowledge-processing-consent.js';
import {
  type GrantFileRead,
  type GrantStateFinding,
  readGrantFile,
  requireGrantStoreDir,
  resolveGrantStoreDir,
  withGrantFileMutation,
} from './user-local-grant-store.js';
import { formatZodIssues } from './zod-issues.js';
import { ErrorCodes, OrcaopsError } from '../io/errors.js';

/**
 * The user-local store of consent to background knowledge processing. It sits
 * beside `evaluator-grants.json` in the config home and must resolve outside
 * the repository like it, but it is a separate file with its own version: a
 * released binary that met an unknown grant kind inside
 * `evaluator-grants.json` would drop every evaluator grant.
 *
 * It is stricter than the evaluator store about widened permissions. Reading
 * never repairs anything and never trusts a store other users can reach, and a
 * change refuses a store other users could have written.
 *
 * Grants are kept for audit. Nothing here deletes an entry; a grant stops
 * counting when `revoked_at` is recorded on it.
 */

export const PROCESSING_GRANTS_FILE_NAME = 'knowledge-processing-grants.json';

const STORE_LABEL = 'knowledge processing grants';

export function processingGrantsFilePath(configDir: string = defaultConfigDir()): string {
  return path.join(configDir, PROCESSING_GRANTS_FILE_NAME);
}

interface StoreLocation {
  repoRoot: string;
  configDir?: string;
}

export interface ProcessingGrantsRead {
  grants: ProcessingGrant[];
  /** Non-empty exactly when the store could not be relied on; `grants` is then empty. */
  problems: ProcessingGrantStoreProblem[];
}

/**
 * The one read, for the worker and for diagnostics alike. It changes nothing
 * on disk. A directory or file that other users can reach yields no grants and
 * a problem that says how to put it right.
 */
export function readProcessingGrants(location: StoreLocation): ProcessingGrantsRead {
  const resolution = resolveGrantStoreDir(location);
  if (!resolution.ok) {
    return {
      grants: [],
      problems: [
        resolution.reason === 'repository_root_invalid'
          ? {
              code: 'repository_root_invalid',
              message:
                `Repository root ${JSON.stringify(location.repoRoot)} must be an existing ` +
                `absolute directory.`,
            }
          : {
              code: 'store_not_outside_repository',
              message:
                `The grant store ${JSON.stringify(resolution.requestedDir)} must be an absolute ` +
                `location outside the repository; repository-controlled configuration cannot ` +
                `mint consent.`,
            },
      ],
    };
  }
  const file = processingGrantsFilePath(resolution.dir);
  const read = readGrantFile(resolution.dir, file, ProcessingGrantsFileSchema, 'inspect');
  if (read.status === 'ok') return { grants: read.contents.grants, problems: [] };
  return { grants: [], problems: fileProblems(read, file) };
}

export function listProcessingGrants(
  location: StoreLocation,
  filter: { project_id?: string } = {}
): { entries: ProcessingGrantStatus[]; problems: ProcessingGrantStoreProblem[] } {
  const { grants, problems } = readProcessingGrants(location);
  return { entries: describeProcessingGrants(grants, filter), problems };
}

function stateProblem(finding: GrantStateFinding): ProcessingGrantStoreProblem {
  const codes = {
    unsafe: 'store_unsafe',
    readable_by_others: 'store_permissions_widened',
    writable_by_others: 'store_writable_by_others',
  } as const;
  return { code: codes[finding.kind], message: finding.message };
}

function fileProblems(
  read: Exclude<GrantFileRead<ProcessingGrantsFile>, { status: 'ok' }>,
  file: string
): ProcessingGrantStoreProblem[] {
  switch (read.status) {
    case 'absent':
      return [];
    case 'unsafe':
      return read.findings.map(stateProblem);
    case 'unparseable':
      return [
        {
          code: 'grant_file_unparseable',
          message:
            `${file} is not parseable JSON, so nothing in it is in force. Move it aside and ` +
            `grant consent again.`,
        },
      ];
    case 'invalid':
      return [
        {
          code: 'grant_file_invalid',
          message:
            `${file} does not match the version 1 grant format this build reads, so nothing in ` +
            `it is in force. If a newer orcaops wrote it, use that version; otherwise move it ` +
            `aside and grant consent again.`,
        },
      ];
  }
}

export interface ProcessingGrantTerms {
  /** The project store identity. Never derive it from repository configuration. */
  project_id: string;
  provider: ProcessingProvider;
  /** The grant covers exactly this processor contract version. */
  processor_contract: string;
  /**
   * `backlog` has no default: covering jobs admitted before the grant is always
   * spelled out. The enable flow reads `admitted_after_sequence` from the
   * project database itself, never from input or configuration: 0 with backlog
   * excluded would cover the whole backlog without the explicit word.
   */
  source_scope: ProcessingSourceScope;
  disclosed: Omit<ProcessingDisclosure, 'provider'>;
}

const TERM_FIELDS = [
  'project_id',
  'provider',
  'processor_contract',
  'source_scope',
  'disclosed',
] as const satisfies readonly (keyof ProcessingGrantTerms)[];

/** Parsing orders every key as the schema does, so equal terms serialize equally. */
function parseTerms(terms: unknown): ProcessingGrantTerms {
  const parsed = ProcessingGrantTermsSchema.safeParse(terms);
  if (parsed.success) return parsed.data;
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `invalid knowledge processing grant terms: ${formatZodIssues(parsed.error.issues)}`
  );
}

const constructionToken = Symbol('interactive consent confirmation');

let spendConfirmation: (confirmation: unknown) => ProcessingGrantTerms;

/**
 * Proof that a person accepted exactly these terms at an interactive terminal.
 * It is bound to the terms it was built from and records one grant, once.
 *
 * Only an interactive enable flow may build one, after the person answered its
 * prompt for the same terms. Consent is interactive only: there is no `--yes`
 * equivalent, and a skill, hook, background job or worker must never build one.
 *
 * What this stops: an accident. A boolean, a flag value, an object literal, a
 * subclass, `new` and `Reflect.construct` are all refused, and the terminal
 * check reads this process's own standard input and output, so a caller cannot
 * hand in a stream that claims to be a terminal.
 *
 * What it does not stop: a process running as the same user can write the
 * grant file directly, or drive a real terminal. Evaluator grants have the
 * same limit; the store's ownership and permission rules are the boundary.
 */
export class InteractiveConsentConfirmation {
  readonly #confirmedTerms: ProcessingGrantTerms;
  #spent = false;

  private constructor(token: symbol, confirmedTerms: ProcessingGrantTerms) {
    if (token !== constructionToken || new.target !== InteractiveConsentConfirmation) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'An interactive consent confirmation can only come from forTermsAcceptedAtTerminal.'
      );
    }
    this.#confirmedTerms = confirmedTerms;
  }

  static forTermsAcceptedAtTerminal(terms: ProcessingGrantTerms): InteractiveConsentConfirmation {
    if (!isatty(0) || !isatty(1)) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        'Consent to knowledge processing can only be given at an interactive terminal.'
      );
    }
    return new InteractiveConsentConfirmation(constructionToken, parseTerms(terms));
  }

  static {
    spendConfirmation = (confirmation) => {
      if (
        typeof confirmation !== 'object' ||
        confirmation === null ||
        !(#confirmedTerms in confirmation)
      ) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          'refusing to record a knowledge processing grant without an interactive confirmation'
        );
      }
      if (confirmation.#spent) {
        throw new OrcaopsError(
          ErrorCodes.INVALID_INPUT,
          'refusing to record a knowledge processing grant: this confirmation was already used, ' +
            'and each grant needs its own'
        );
      }
      confirmation.#spent = true;
      return confirmation.#confirmedTerms;
    };
  }
}

/**
 * Records a new grant for exactly the terms the confirmation was built from.
 * Any attempt spends the confirmation, whether or not a grant results.
 *
 * Every earlier unrevoked grant for the same project, provider, processor
 * contract and tool-access policy is marked revoked in the same write, so a
 * binding has at most one grant in force and re-granting a narrower scope
 * really narrows it. Grants for a different tool-access policy remain a
 * separate binding.
 * `pairedCommit` runs under the store lock; if it fails the file is restored
 * and no grant was recorded.
 */
export async function recordProcessingGrant(
  terms: ProcessingGrantTerms,
  opts: StoreLocation & {
    interactiveConfirmation: InteractiveConsentConfirmation;
    now?: Date;
    pairedCommit?: (grant: ProcessingGrant) => Promise<void>;
  }
): Promise<{ grant: ProcessingGrant; superseded_grant_ids: string[] }> {
  const confirmed = spendConfirmation(opts.interactiveConfirmation);
  const requested = parseTerms(terms);
  const differing = TERM_FIELDS.filter(
    (field) => JSON.stringify(requested[field]) !== JSON.stringify(confirmed[field])
  );
  if (differing.length > 0) {
    throw new OrcaopsError(
      ErrorCodes.INVALID_INPUT,
      `refusing to record a knowledge processing grant: ${differing.join(', ')} ` +
        `differ from the terms the person confirmed`
    );
  }

  const grantedAt = (opts.now ?? new Date()).toISOString();
  const grant = ProcessingGrantSchema.parse({
    grant_id: randomUUID(),
    capability: PROCESSING_CONSENT_CAPABILITY,
    project_id: confirmed.project_id,
    provider: confirmed.provider,
    processor_contract: confirmed.processor_contract,
    source_scope: confirmed.source_scope,
    disclosed: { provider: confirmed.provider, ...confirmed.disclosed },
    granted_at: grantedAt,
  });

  const { planned } = await mutateStore(
    opts,
    (current) => {
      const superseded = current.filter(
        (existing) =>
          existing.revoked_at === undefined &&
          existing.project_id === grant.project_id &&
          existing.provider === grant.provider &&
          existing.processor_contract === grant.processor_contract &&
          existing.disclosed.tool_access === grant.disclosed.tool_access
      );
      return {
        next: [...withRevocation(current, superseded, grantedAt), grant],
        planned: superseded.map((existing) => existing.grant_id),
      };
    },
    async () => opts.pairedCommit?.(grant)
  );
  return { grant, superseded_grant_ids: planned };
}

/**
 * Revokes every unrevoked grant for the project, or only those naming
 * `provider`. Revocation is never paired with another change that could roll
 * it back.
 */
export async function revokeProcessingGrants(
  target: { project_id: string; provider?: ProcessingProvider },
  opts: StoreLocation & { now?: Date }
): Promise<{ revoked_grant_ids: string[] }> {
  const revokedAt = (opts.now ?? new Date()).toISOString();
  const { planned } = await mutateStore(
    opts,
    (current) => {
      const revoked = current.filter(
        (existing) =>
          existing.revoked_at === undefined &&
          existing.project_id === target.project_id &&
          (target.provider === undefined || existing.provider === target.provider)
      );
      return {
        next: revoked.length > 0 ? withRevocation(current, revoked, revokedAt) : null,
        planned: revoked.map((existing) => existing.grant_id),
      };
    },
    async () => undefined
  );
  return { revoked_grant_ids: planned };
}

function withRevocation(
  grants: readonly ProcessingGrant[],
  revoked: readonly ProcessingGrant[],
  revokedAt: string
): ProcessingGrant[] {
  return grants.map((grant) =>
    revoked.includes(grant) ? { ...grant, revoked_at: revokedAt } : grant
  );
}

function refuseToChange(problems: readonly ProcessingGrantStoreProblem[]): never {
  throw new OrcaopsError(
    ErrorCodes.INVALID_INPUT,
    `refusing to change ${STORE_LABEL}: ${problems.map((problem) => problem.message).join(' ')}`
  );
}

async function mutateStore<Planned>(
  location: StoreLocation,
  change: (current: ProcessingGrant[]) => { next: ProcessingGrant[] | null; planned: Planned },
  commit: () => Promise<void>
): Promise<{ planned: Planned }> {
  const dir = requireGrantStoreDir(location, STORE_LABEL);
  const file = processingGrantsFilePath(dir);
  return withGrantFileMutation(
    {
      dir,
      file,
      lockName: 'knowledge-processing-grants',
      rollbackFailureMessage:
        'Knowledge processing grant change failed and restoring the grant file also failed.',
      // Read bits exposed the contents but could not alter them, so those are
      // tightened and the change proceeds. Anything else leaves contents that
      // tightening the mode cannot make trustworthy again.
      refuseState: (findings) => {
        const untrusted = findings.filter((finding) => finding.kind !== 'readable_by_others');
        if (untrusted.length > 0) refuseToChange(untrusted.map(stateProblem));
      },
    },
    () => {
      const read = readGrantFile(dir, file, ProcessingGrantsFileSchema, 'inspect');
      // Rewriting a file this build cannot read would silently drop its audit
      // trail and its revocations, or a newer build's format.
      if (read.status !== 'ok' && read.status !== 'absent')
        refuseToChange(fileProblems(read, file));
      const { next, planned } = change(read.status === 'ok' ? read.contents.grants : []);
      return {
        contents:
          next === null
            ? null
            : `${JSON.stringify({ v: 1, grants: next } satisfies ProcessingGrantsFile, null, 2)}\n`,
        planned,
      };
    },
    commit
  );
}
