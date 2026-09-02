import { describe, expect, it } from 'vitest';

import {
  LoopbackOauthError,
  LoopbackProtocolError,
  LoopbackStateMismatchError,
  LoopbackTimeoutError,
  startLoopbackServer,
} from './loopback-server.js';

describe('startLoopbackServer', () => {
  it('binds to 127.0.0.1 on an ephemeral port and resolves with code on /callback', async () => {
    const handle = await startLoopbackServer({ state: 'st_abc', timeoutMs: 5000 });
    try {
      expect(handle.port).toBeGreaterThan(0);
      const browserResponse = await fetch(
        `http://127.0.0.1:${handle.port}/callback?code=ac_xyz&state=st_abc`
      );
      const body = await browserResponse.text();
      expect(browserResponse.status).toBe(200);
      expect(body).toContain('Login complete');
      const result = await handle.awaitCallback();
      expect(result.code).toBe('ac_xyz');
    } finally {
      handle.shutdown();
    }
  });

  it('rejects on state mismatch and returns 400', async () => {
    const handle = await startLoopbackServer({ state: 'expected', timeoutMs: 5000 });
    try {
      const browserResponse = await fetch(
        `http://127.0.0.1:${handle.port}/callback?code=ac_xyz&state=different`
      );
      expect(browserResponse.status).toBe(400);
      await expect(handle.awaitCallback()).rejects.toBeInstanceOf(LoopbackStateMismatchError);
    } finally {
      handle.shutdown();
    }
  });

  it('rejects on error= callback param and propagates the OAuth error code', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    try {
      void fetch(
        `http://127.0.0.1:${handle.port}/callback?error=access_denied&error_description=user+cancelled&state=st`
      );
      try {
        await handle.awaitCallback();
        throw new Error('expected reject');
      } catch (err) {
        expect(err).toBeInstanceOf(LoopbackOauthError);
        const oauthErr = err as LoopbackOauthError;
        expect(oauthErr.oauthError).toBe('access_denied');
        expect(oauthErr.oauthErrorDescription).toBe('user cancelled');
      }
    } finally {
      handle.shutdown();
    }
  });

  it('rejects with LoopbackProtocolError when callback omits code', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    try {
      void fetch(`http://127.0.0.1:${handle.port}/callback?state=st`);
      await expect(handle.awaitCallback()).rejects.toBeInstanceOf(LoopbackProtocolError);
    } finally {
      handle.shutdown();
    }
  });

  it('times out cleanly when no callback arrives', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 200 });
    try {
      await expect(handle.awaitCallback()).rejects.toBeInstanceOf(LoopbackTimeoutError);
    } finally {
      handle.shutdown();
    }
  });

  it('returns 404 for paths other than /callback', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/nope`);
      expect(res.status).toBe(404);
    } finally {
      handle.shutdown();
    }
  });

  it('responds 204 to /favicon.ico without affecting the callback state machine', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/favicon.ico`);
      expect(res.status).toBe(204);
      // Callback machine still pending; success path still works.
      void fetch(`http://127.0.0.1:${handle.port}/callback?code=ac&state=st`);
      const result = await handle.awaitCallback();
      expect(result.code).toBe('ac');
    } finally {
      handle.shutdown();
    }
  });

  it('responds politely to a second /callback after the flow completed', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    try {
      void fetch(`http://127.0.0.1:${handle.port}/callback?code=ac&state=st`);
      await handle.awaitCallback();
      const second = await fetch(`http://127.0.0.1:${handle.port}/callback?code=ac2&state=st`);
      expect(second.status).toBe(200);
      const body = await second.text();
      expect(body).toContain('Already received');
    } finally {
      handle.shutdown();
    }
  });

  it('shutdown is idempotent', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000 });
    handle.shutdown();
    expect(() => handle.shutdown()).not.toThrow();
  });

  it('honors the bind override', async () => {
    const handle = await startLoopbackServer({ state: 'st', timeoutMs: 5000, bind: '127.0.0.1' });
    try {
      expect(handle.port).toBeGreaterThan(0);
    } finally {
      handle.shutdown();
    }
  });
});
