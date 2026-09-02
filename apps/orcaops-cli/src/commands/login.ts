import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import open from 'open';

import {
  assertSameOriginDiscovery,
  assertSameOriginUrl,
  createHardenedFetch,
  envTokenIsSet,
  FileStore,
  flushPendingPushes,
  resolveCloudTarget,
  resolveCredentialStore,
  scrubAndBound,
  startLoopbackServer,
} from '@orcaops/core';
import {
  codeChallengeS256,
  createAuthedCloudClient,
  type CredentialStore,
  exchangeCode,
  fetchDiscovery,
  generateCodeVerifier,
  getAuthState,
  type StoredCredentials,
} from '@orcaops/sdk';

import { ErrorCodes, OrcaopsError } from '../io/errors.js';
import { emitError, emitOk, writeTerminalSafeStdout } from '../io/output.js';
import { CLI_VERSION } from '../lib/cli-version.js';
import { getInvocationEnv } from '../lib/invocation-context.js';

const CLIENT_ID = 'orcaops-cli';
const SCOPE = 'cli:full offline_access';
const TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginOptions {
  baseUrl?: string;
  /** Forces the browser to re-show consent (sets prompt=consent on /authorize). */
  forceConsent?: boolean;
  /** Forces full re-auth — org picker shown even for single-org users. Same code path; UX hint to the user. */
  reauth?: boolean;
  json?: boolean;
  /** Override the credential store. Tests inject a tmpdir-backed FileStore so the suite doesn't touch the user's keyring. */
  store?: CredentialStore;
  /** Disable the actual browser launch. Tests pass false; real CLI uses true. */
  openBrowser?: boolean;
  /** Test hook — fires once with the authorize URL right before open() would be invoked. Tests use this to drive the browser-side flow against the in-process mock AS. */
  onAuthorizeUrl?(url: string): void | Promise<void>;
}

export async function loginAction(opts: LoginOptions): Promise<void> {
  try {
    if (envTokenIsSet()) {
      throw new OrcaopsError(
        ErrorCodes.INVALID_INPUT,
        `ORCAOPS_TOKEN is set; you are using env-based auth. Unset it to log in interactively.`
      );
    }

    const store = opts.store ?? resolveCredentialStore();
    const baseUrl = resolveCloudTarget(opts.baseUrl);
    let existing = await Promise.resolve(store.read(baseUrl));
    if (existing && !opts.reauth) {
      await createAuthedCloudClient({
        baseUrl,
        credentialStore: store,
        fetch: createHardenedFetch(baseUrl),
        cliVersion: CLI_VERSION,
      }).ensureFreshToken();
      const state = await getAuthState(store, baseUrl);
      if (state.kind === 'connected') {
        existing = (await Promise.resolve(store.read(baseUrl))) ?? existing;
        const expiresMins = Math.max(0, Math.floor((existing.expiresAt - now()) / 60));
        // A logged-in user in a fresh clone missing the cloud skills reaches for
        // exactly this command; requiring a full browser `--reauth` would not do.
        const cloudSkills = await materializeCloudSkillsAfterLogin();
        if (opts.json) {
          // The same key set as the fresh-auth envelope, so a consumer never
          // branches on `alreadyLoggedIn` to know which fields exist. `drain` is
          // null rather than absent — this path is often just a probe, and making
          // it a network write would be a behaviour change with no upside.
          emitOk({
            alreadyLoggedIn: true,
            baseUrl,
            userId: existing.userId,
            orgId: existing.orgId,
            orgName: existing.orgName,
            orgSlug: existing.orgSlug,
            email: existing.email,
            storage: store.kind,
            expiresInSeconds: existing.expiresAt - now(),
            drain: null,
            cloudSkills,
          });
          return;
        }
        writeStdout(
          `You're already logged in as ${existing.email || existing.userId} for ${existing.orgName ?? existing.orgId}.\n` +
            `Token expires in ${expiresMins} min (will auto-refresh).\n` +
            `To switch orgs, run: orcaops login --reauth`
        );
        reportCloudSkills(cloudSkills);
        return;
      }
    }

    // --reauth = clean slate. Clear the existing entry BEFORE the loopback
    // flow so a mid-exchange failure (network blip, browser close, timeout)
    // doesn't leave stale tokens on disk while the user thinks they re-
    // authed. Without this, the next `orcaops login` short-circuits on
    // the stale row at the check above and the user has to manually
    // clear or pass --reauth twice.
    if (existing && opts.reauth) {
      try {
        await Promise.resolve(store.clear(baseUrl));
      } catch (err) {
        // Best-effort — log but proceed. The store.write at flow end
        // overwrites whatever's there.
        if (!opts.json) {
          writeStdout(
            `Warning: could not clear stale credentials for ${baseUrl}: ` +
              scrubAndBound(err instanceof Error ? err.message : String(err), 512)
          );
        }
      }
    }

    const hardenedFetch = createHardenedFetch(baseUrl);
    const meta = await fetchDiscovery(baseUrl, { fetch: hardenedFetch });
    // The SDK schema only requires non-empty strings; validate the
    // endpoints BEFORE any of them is acted on — authorization_endpoint
    // goes to the browser, which the hardened fetch never sees.
    assertSameOriginDiscovery(meta, baseUrl);

    const verifier = generateCodeVerifier();
    const challenge = await codeChallengeS256(verifier);
    const state = randomBytes(32).toString('base64url');

    const loopback = await startLoopbackServer({ state, timeoutMs: TIMEOUT_MS });
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

    const authzUrl = new URL(meta.authorization_endpoint);
    authzUrl.searchParams.set('response_type', 'code');
    authzUrl.searchParams.set('client_id', CLIENT_ID);
    authzUrl.searchParams.set('redirect_uri', redirectUri);
    authzUrl.searchParams.set('scope', SCOPE);
    authzUrl.searchParams.set('code_challenge', challenge);
    authzUrl.searchParams.set('code_challenge_method', 'S256');
    authzUrl.searchParams.set('state', state);
    if (opts.forceConsent) authzUrl.searchParams.set('prompt', 'consent');

    // Final gate on the exact URL the browser (and the printed fallback)
    // will receive — nothing between here and launch may change it.
    assertSameOriginUrl(authzUrl.toString(), baseUrl, 'authorization URL');

    if (!opts.json) {
      writeStdout(
        `Opening browser to authorize.\n` +
          `If the browser doesn't open, visit:\n  ${authzUrl}\n\n` +
          `Waiting for confirmation... (timing out in 5:00)`
      );
    }

    if (opts.onAuthorizeUrl) {
      // Fire-and-forget — the hook may itself drive the loopback callback.
      void Promise.resolve(opts.onAuthorizeUrl(authzUrl.toString())).catch(() => undefined);
    }
    if (opts.openBrowser !== false) {
      // Browser-opener failure is non-fatal; URL is already printed.
      void open(authzUrl.toString()).catch(() => undefined);
    }

    const sigintHandler = (): void => {
      loopback.shutdown();
      // SIGINT handler runs outside the action's call stack — there's no
      // catch frame for a CliExit throw to reach, so we exit directly.
      // eslint-disable-next-line no-restricted-syntax
      process.exit(130);
    };
    process.once('SIGINT', sigintHandler);

    let credentials: StoredCredentials;
    try {
      const callback = await loopback.awaitCallback();
      const tokens = await exchangeCode({
        tokenEndpoint: meta.token_endpoint,
        code: callback.code,
        verifier,
        clientId: CLIENT_ID,
        redirectUri,
        resource: baseUrl,
        fetch: hardenedFetch,
      });
      // Identity lookup via the SDK's typed `user.me`. The bearer is
      // opaque (cloud's `disableJwtPlugin: true` makes access tokens
      // random 32-char strings, not JWTs), so we can't extract userId /
      // orgId / email by decoding the token. The SDK's user.me hits
      // /api/trpc/user.me with Bearer auth and returns the identity
      // shape we need to populate StoredCredentials.
      //
      // `createAuthedCloudClient` reads the bearer from a credential
      // store; we don't have anything in the real store yet (we're
      // ABOUT to write it). Pass an ephemeral in-memory store containing
      // just the tokens so the SDK can attach the Bearer header. Once
      // identity comes back, we write the complete blob to the real
      // store. This keeps the SDK as the single wire surface — no
      // direct fetches from CLI code.
      const ephemeralBlob: StoredCredentials = {
        v: 1,
        loginMethod: 'oauth',
        baseUrl,
        userId: '',
        orgId: '',
        orgName: null,
        orgSlug: null,
        email: '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now() + tokens.expiresIn,
      };
      const ephemeralStore: CredentialStore = {
        kind: 'env',
        read: () => ephemeralBlob,
        write: () => {},
        clear: () => {},
      };
      const probeClient = createAuthedCloudClient({
        baseUrl,
        credentialStore: ephemeralStore,
        fetch: hardenedFetch,
        cliVersion: CLI_VERSION,
      });
      const identity = await probeClient.client.user.me();
      credentials = {
        v: 1,
        loginMethod: 'oauth',
        baseUrl,
        userId: identity.user.id,
        orgId: identity.organization?.id ?? '',
        orgName: identity.organization?.name ?? null,
        orgSlug: identity.organization?.slug ?? null,
        email: identity.user.email ?? '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: now() + tokens.expiresIn,
      };
      await Promise.resolve(store.write(baseUrl, credentials));
    } finally {
      process.removeListener('SIGINT', sigintHandler);
      loopback.shutdown();
    }

    // Best-effort push-on-login: drain pending artifacts whose prior push
    // (if any) targeted the just-authenticated org. Skips silently when not
    // in an orcaops-init'd repo (login can run from anywhere) or when the
    // git remote isn't configured. Threads the just-resolved (store,
    // baseUrl) through so flushPendingPushes resolves the same credential
    // store that this login wrote to — without the explicit thread,
    // `resolveCredentialStore()` inside flushPendingPushes could pick a
    // different store in a multi-store env, and the cross-org filter
    // would key off the wrong orgId.
    const drainResult = await drainAfterLogin({
      baseUrl,
      orgId: credentials.orgId,
      credentialStore: store,
    });

    // The cloud skills are gated on credential presence, which this login has
    // just satisfied — materialize them now so the session is usable without a
    // follow-up `orcaops update`.
    const cloudSkills = await materializeCloudSkillsAfterLogin();

    if (opts.json) {
      emitOk({
        alreadyLoggedIn: false,
        baseUrl,
        userId: credentials.userId,
        orgId: credentials.orgId,
        orgName: credentials.orgName,
        orgSlug: credentials.orgSlug,
        email: credentials.email,
        storage: store.kind,
        expiresInSeconds: credentials.expiresAt - now(),
        drain: drainResult,
        cloudSkills,
      });
      return;
    }
    writeStdout(
      `Logged in as ${credentials.email || credentials.userId} for ` +
        `${credentials.orgName ?? credentials.orgId} (storage: ${store.kind}). ` +
        `Use \`orcaops org switch\` to re-authorize for a different org.`
    );
    if (drainResult && drainResult.attempted > 0) {
      writeStdout(`Pushed ${drainResult.attempted} pending artifact(s).`);
    }
    reportCloudSkills(cloudSkills);
    if (drainResult && drainResult.skippedForeignOrg > 0) {
      // Cross-tenant guard fired — surface so the user knows the drain
      // didn't push EVERYTHING in the local queue. Common case: user
      // switched orgs and re-logged in; the previous org's captures stay
      // pinned to that org until the user logs back into it.
      writeStdout(
        `Skipped ${drainResult.skippedForeignOrg} artifact(s) from another org ` +
          `(re-login to the original org to push them).`
      );
    }
  } catch (err) {
    emitError(err);
  }
}

interface DrainSummary {
  attempted: number;
  timedOut: boolean;
  /**
   * Count of artifacts skipped because their last cloud push targeted a
   * DIFFERENT org than the one this login just authenticated against. The
   * cross-tenant guard at the drain candidate query (sqlite.ts
   * findArtifactsForCloudSyncDrain with orgIdFilter) excludes them.
   * Fresh (never-pushed) artifacts are always included; only previously-
   * pushed-to-other-org rows count here.
   */
  skippedForeignOrg: number;
}

interface DrainAfterLoginOptions {
  baseUrl: string;
  orgId: string;
  credentialStore: CredentialStore;
}

async function drainAfterLogin(opts: DrainAfterLoginOptions): Promise<DrainSummary | null> {
  // Honor the kill-switch BEFORE buildContext: flushPendingPushes would skip
  // anyway, but buildContext itself is side-effectful: it resolves the repo
  // root from the invocation cwd and can rebuild a missing or interrupted
  // cache. A disabled drain must not touch whatever repo the process happens
  // to be sitting in.
  if (getInvocationEnv().ORCAOPS_DISABLE_DRAIN === '1') return null;
  let ctx;
  try {
    const { buildContext } = await import('../lib/context.js');
    ctx = await buildContext();
  } catch {
    return null;
  }
  try {
    // Thread baseUrl + credentialStore through so flushPendingPushes's
    // internal `resolveAuthedOrgId` reads the same store this login just
    // wrote credentials to. Without the explicit thread, the helper would
    // call `resolveCredentialStore()` itself, which in a multi-store env
    // (FileStore + KeyringStore both present) could return a different
    // store — the cross-org filter would key off whichever orgId that
    // store happens to hold, defeating the guard.
    const result = await flushPendingPushes({
      store: ctx.store,
      repo: ctx.repo,
      repoRoot: ctx.repoRoot,
      credentialStore: opts.credentialStore,
      baseUrl: opts.baseUrl,
    });
    if (result.skipped) return null;
    return {
      attempted: result.attempted,
      timedOut: result.timedOut,
      skippedForeignOrg: result.skippedForeignOrg,
    };
  } catch {
    return null;
  } finally {
    ctx.store.close();
  }
}

const require = createRequire(import.meta.url);
const cliPkg = require('../../package.json') as { version: string };

type CloudSkillsOutcome =
  | { status: 'installed'; installed: string[]; refreshed: string[]; warnings: string[] }
  /** Materialization lives outside the repo under these scopes — `update` owns it. */
  | { status: 'update-required'; scope: 'global' | 'personal' }
  | {
      status: 'skipped';
      reason: 'disabled' | 'no-repo' | 'not-installed' | 'stale-install';
      /** Which preflight disagreed, on `stale-install` — one flat line cannot say. */
      refusal?: 'prefix-mismatch' | 'agent-set-mismatch';
    }
  | { status: 'failed'; error: string };

/**
 * Materialize the newly-unlocked cloud skills into the repo this login was run
 * from, so the session is usable without a follow-up `orcaops update`.
 *
 * Writes only the cloud-gated skill files and merges their entries into the two
 * manifests — no managed block, slash commands, `.gitignore`, prune or global
 * install, because an auth command must not become an update.
 *
 * Never `updateAction`: it reports failure through `emitError`, which throws, so
 * one stale file would turn a successful login into a failure envelope. Every
 * error here is swallowed into the returned outcome instead.
 */
async function materializeCloudSkillsAfterLogin(): Promise<CloudSkillsOutcome> {
  // Checked before buildContext, which resolves a repo root from the invocation
  // cwd and can write a config migration: a disabled hook touches nothing.
  if (getInvocationEnv().ORCAOPS_DISABLE_DRAIN === '1') {
    return { status: 'skipped', reason: 'disabled' };
  }
  let ctx;
  try {
    const { buildContext } = await import('../lib/context.js');
    ctx = await buildContext();
  } catch {
    return { status: 'skipped', reason: 'no-repo' };
  }
  try {
    // BEFORE the manifest read: personal scope has no committed install.json at
    // all, so a manifest-first check reports it as never-installed forever.
    const scope = ctx.config.install.scope;
    if (scope === 'global' || scope === 'personal') return { status: 'update-required', scope };

    const { readInstallManifest, readLocalManifest } = await import('../lib/install-manifest.js');
    const prevInstall = await readInstallManifest(ctx.repoRoot);
    // Not installed here, so generating files would be a surprise write.
    if (!prevInstall) return { status: 'skipped', reason: 'not-installed' };
    if (ctx.config.install.agents.length === 0) {
      return { status: 'skipped', reason: 'not-installed' };
    }

    const { planCloudSkillMaterialization } = await import('../lib/install-plan.js');
    const { executeMutations } = await import('../lib/mutations.js');
    const plan = await planCloudSkillMaterialization({
      repoRoot: ctx.repoRoot,
      agents: ctx.config.install.agents,
      config: ctx.config,
      generatedBy: cliPkg.version,
      prevInstall,
      prevLocal: await readLocalManifest(ctx.repoRoot),
    });
    if (plan.refusal) return { status: 'skipped', reason: 'stale-install', refusal: plan.refusal };
    await executeMutations(plan.mutations, 'apply');
    return {
      status: 'installed',
      installed: plan.installed,
      refreshed: plan.refreshed,
      warnings: plan.warnings,
    };
  } catch (err) {
    // The login itself succeeded and the credentials are written, so this never
    // fails the command — but it must not vanish either, or a permission fault
    // leaves a good session with no skills and nothing to act on.
    return {
      status: 'failed',
      error: scrubAndBound(err instanceof Error ? err.message : String(err), 512),
    };
  } finally {
    ctx.store.close();
  }
}

/**
 * The human-path report, shared by both login paths. The counts are the cloud
 * subset by construction, since the planner renders nothing else.
 */
function reportCloudSkills(outcome: CloudSkillsOutcome): void {
  if (outcome.status === 'failed') {
    writeStdout(
      `Warning: the cloud skills could not be installed: ${outcome.error}\n` +
        `You are logged in; run \`orcaops update\` to install them.`
    );
    return;
  }
  if (outcome.status === 'update-required') {
    writeStdout(
      `Cloud skills are unlocked — run \`orcaops update\` to materialize them ` +
        `(install scope: ${outcome.scope}).`
    );
    return;
  }
  if (outcome.status === 'skipped' && outcome.reason === 'stale-install') {
    const what =
      outcome.refusal === 'prefix-mismatch'
        ? 'its naming prefix'
        : outcome.refusal === 'agent-set-mismatch'
          ? 'its install agent set'
          : 'its config';
    writeStdout(
      `Cloud skills are unlocked, but this repo's install manifest disagrees with ` +
        `${what} — run \`orcaops update\` to reconcile it.`
    );
    return;
  }
  if (outcome.status !== 'installed') return;
  const touched = outcome.installed.length + outcome.refreshed.length;
  if (touched > 0) {
    writeStdout(
      `Cloud skills ready: ${outcome.installed.length} installed, ` +
        `${outcome.refreshed.length} refreshed.`
    );
  }
  for (const w of outcome.warnings) writeStdout(`Note: ${w}`);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function writeStdout(line: string): void {
  writeTerminalSafeStdout(`${line}\n`);
}

/**
 * Diagnostic helper. Returns the OAuth credential blob for the given baseUrl,
 * or null when the resolved store has no entry. Async, and resolves the
 * `StoredCredentials` shape.
 */
export async function readStoredCredentials(baseUrl: string): Promise<StoredCredentials | null> {
  const store = resolveCredentialStore();
  return Promise.resolve(store.read(baseUrl));
}

/** Re-export so tests can construct a tmpdir-backed FileStore without importing @orcaops/core directly. */
export { FileStore };
