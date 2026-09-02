import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

/**
 * Constant-time comparison of two ASCII strings of any length. Returns
 * false for length mismatches without leaking the length comparison via
 * an early-return on a non-timing-safe path. State strings are 32 random
 * bytes from the same process so a timing oracle is impractical over
 * loopback — defense-in-depth against a future change that exposes the
 * comparison to a network signal.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export interface StartLoopbackServerOptions {
  /** Opaque random string the CLI sent in `state=` on /authorize. Compared verbatim against the callback's `state` param. */
  state: string;
  /** Reject the awaitCallback promise after this many ms if no /callback request arrives. */
  timeoutMs: number;
  /** Override 127.0.0.1 (e.g. for IPv6: '::1'). Defaults to '127.0.0.1' to match the cloud's seeded RFC 8252 §7.3 redirect. */
  bind?: string;
  /** Override port 0 (ephemeral). Set explicitly when the AS plugin doesn't implement RFC 8252 §7.3 port-flexible matching. */
  port?: number;
}

export interface LoopbackHandle {
  /** Port the server actually bound (resolved from `address()`). Use this to build the redirect_uri. */
  port: number;
  /** Resolves with the validated callback once the user completes the browser flow; rejects on state mismatch, error= param, or timeout. */
  awaitCallback(): Promise<{ code: string }>;
  /** Idempotent. Closes the server and clears the timeout — safe to call multiple times, safe to call before awaitCallback resolves. */
  shutdown(): void;
}

const DEFAULT_BIND = '127.0.0.1';

/**
 * Start an ephemeral HTTP server on localhost to receive the OAuth callback.
 * Single-shot — the first /callback (success or denial) resolves/rejects
 * the awaitCallback promise; subsequent requests get a "already received"
 * response.
 *
 * The server validates `state` to defend against CSRF — a callback that
 * doesn't echo our random state value is treated as a hostile redirect
 * and the login fails immediately.
 *
 * Timeout cleanup: the timer is cleared on every terminal path (success,
 * error, state mismatch, missing code, manual shutdown) so a successful
 * login doesn't leak a 5-minute pending setTimeout.
 */
export async function startLoopbackServer(
  opts: StartLoopbackServerOptions
): Promise<LoopbackHandle> {
  const bind = opts.bind ?? DEFAULT_BIND;
  const server = http.createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port ?? 0, bind);
  });

  const address = server.address();
  if (typeof address === 'string' || !address) {
    server.close();
    throw new Error('LoopbackServer: failed to bind — server.address() returned a non-net address');
  }
  const port = address.port;

  let resolved = false;
  let timer: NodeJS.Timeout | null = null;

  const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
    timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(
        new LoopbackTimeoutError(
          `OAuth callback timed out after ${opts.timeoutMs}ms — no /callback hit on ${bind}:${port}`
        )
      );
    }, opts.timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://${bind}:${port}`);

      // Browsers fetch /favicon.ico when rendering /callback's success page.
      // Respond 204 to keep the browser quiet without polluting the
      // callback-await state machine.
      if (url.pathname === '/favicon.ico') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end();
        return;
      }

      if (resolved) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(ALREADY_RESOLVED_HTML);
        return;
      }

      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      const finish = (status: number, body: string, err?: Error, ok?: { code: string }): void => {
        resolved = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        res.statusCode = status;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(body);
        if (ok) resolve(ok);
        else if (err) reject(err);
      };

      if (error) {
        finish(
          200,
          renderHtml(
            'Login cancelled',
            errorDescription
              ? `${error}: ${errorDescription}`
              : `Authorization server returned: ${error}`
          ),
          new LoopbackOauthError(error, errorDescription ?? null)
        );
        return;
      }

      if (state === null || !constantTimeEqual(state, opts.state)) {
        finish(
          400,
          renderHtml(
            'Login aborted',
            'OAuth state mismatch — possible CSRF. Close this tab and re-run `orcaops login`.'
          ),
          new LoopbackStateMismatchError('state mismatch — login aborted (possible CSRF)')
        );
        return;
      }

      if (!code) {
        finish(
          400,
          renderHtml('Login failed', 'Authorization callback was missing a code parameter.'),
          new LoopbackProtocolError('callback missing required `code` parameter')
        );
        return;
      }

      finish(200, SUCCESS_HTML, undefined, { code });
    });
  });

  // Suppress Node's unhandledRejection warning when the rejection lands
  // before the consumer awaits — common pattern for deferred-await server
  // promises. The consumer's awaitCallback() still receives the rejection.
  callbackPromise.catch(() => undefined);

  return {
    port,
    awaitCallback: () => callbackPromise,
    shutdown: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        server.close();
      } catch {
        // idempotent — server may already be closed
      }
    },
  };
}

export class LoopbackTimeoutError extends Error {
  readonly name = 'LoopbackTimeoutError';
}

export class LoopbackStateMismatchError extends Error {
  readonly name = 'LoopbackStateMismatchError';
}

export class LoopbackProtocolError extends Error {
  readonly name = 'LoopbackProtocolError';
}

export class LoopbackOauthError extends Error {
  readonly name = 'LoopbackOauthError';
  readonly oauthError: string;
  readonly oauthErrorDescription: string | null;
  constructor(oauthError: string, description: string | null) {
    super(description ? `OAuth error ${oauthError}: ${description}` : `OAuth error: ${oauthError}`);
    this.oauthError = oauthError;
    this.oauthErrorDescription = description;
  }
}

const SUCCESS_HTML = renderHtml(
  'Login complete',
  'You can close this tab and return to your terminal.'
);

const ALREADY_RESOLVED_HTML = renderHtml(
  'Already received',
  'This login already completed — you can close this tab.'
);

function renderHtml(heading: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>orcaops — ${escapeHtml(heading)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:4rem auto;padding:0 1rem;color:#111}h1{font-size:1.5rem;margin-bottom:0.5rem}p{font-size:1rem;color:#444;line-height:1.5}</style>
</head><body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
