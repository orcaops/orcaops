import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DISPOSITIONS } from '../support/cloud-write-surface.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(HERE, '../..');
const SDK_DTS = path.join(CLI_ROOT, 'node_modules/@orcaops/sdk/dist/index.d.ts');
const GATE_CALL = 'assertNoSecretsOutbound';
const SANITIZE_CALL = 'stripHttpUserinfo';

/**
 * Completeness guard for the outbound secret gate.
 *
 * A hand-written inventory of cloud verbs drifts silently — a verb added later
 * is simply absent from it, and absence is invisible. This file holds no
 * inventory of its own: it reads the SDK's `OrcaCloudClient` interface and
 * requires every method on it to be classified in `tests/support`.
 *
 * Adding a namespace or a method to the SDK therefore fails this test until
 * someone decides, explicitly, whether it carries author-written text.
 */

/** Parse `interface OrcaCloudClient` out of the SDK's shipped declarations. */
async function readClientSurface(): Promise<Record<string, string[]>> {
  const dts = await readFile(SDK_DTS, 'utf8');
  const block = /interface OrcaCloudClient \{[\s\S]*?\n\}/.exec(dts);
  if (block === null) throw new Error(`OrcaCloudClient not found in ${SDK_DTS}`);

  const surface: Record<string, string[]> = {};
  for (const [, namespace, body] of block[0].matchAll(/^ {4}(\w+): \{([\s\S]*?)^ {4}\};?$/gm)) {
    surface[namespace] = [...body!.matchAll(/^ {8}(\w+)\(/gm)].map((m) => m[1]!);
  }
  return surface;
}

describe('outbound cloud write surface', () => {
  it('classifies every method the SDK client exposes', async () => {
    const surface = await readClientSurface();
    expect(Object.keys(surface).length).toBeGreaterThan(0);

    const unclassified: string[] = [];
    for (const [namespace, methods] of Object.entries(surface)) {
      for (const method of methods) {
        if (DISPOSITIONS[namespace]?.[method] === undefined) {
          unclassified.push(`${namespace}.${method}`);
        }
      }
    }
    expect(unclassified).toEqual([]);
  });

  it('does not classify methods the SDK no longer exposes', async () => {
    const surface = await readClientSurface();
    const stale: string[] = [];
    for (const [namespace, methods] of Object.entries(DISPOSITIONS)) {
      for (const method of Object.keys(methods)) {
        if (!surface[namespace]?.includes(method)) stale.push(`${namespace}.${method}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('declares every known gap explicitly', async () => {
    const pending: string[] = [];
    for (const [namespace, methods] of Object.entries(DISPOSITIONS)) {
      for (const [method, disposition] of Object.entries(methods)) {
        if (disposition === 'gate-pending') pending.push(`${namespace}.${method}`);
      }
    }
    expect(pending).toEqual([]);
  });

  /**
   * LIMITATION, and the reason this is not the only guard: this reads the
   * gated file as TEXT. It proves the identifier is present, never that the
   * call runs — a call wrapped in `if (0)`, or one placed after the wire
   * send, still satisfies it. `cloud-secret-gate-refusal.test.ts` is what
   * proves each verb actually refuses; this only proves no gated verb's file
   * lost its gate wholesale.
   *
   * That the call also receives the allowlist is enforced by the gate's
   * required `allow` parameter, not here — a grep for the loader's name would
   * be satisfied by an unused import.
   */
  it('gates every verb whose disposition names a file', async () => {
    const ungated: string[] = [];
    for (const [namespace, methods] of Object.entries(DISPOSITIONS)) {
      for (const [method, disposition] of Object.entries(methods)) {
        if (typeof disposition === 'string' || !('gatedIn' in disposition)) continue;
        const source = await readFile(path.join(CLI_ROOT, disposition.gatedIn), 'utf8');
        if (!source.includes(GATE_CALL)) ungated.push(`${namespace}.${method}`);
      }
    }
    expect(ungated).toEqual([]);
  });

  it('sanitizes every verb whose disposition names a sanitizer', async () => {
    const unsanitized: string[] = [];
    for (const [namespace, methods] of Object.entries(DISPOSITIONS)) {
      for (const [method, disposition] of Object.entries(methods)) {
        if (typeof disposition === 'string' || !('sanitizedIn' in disposition)) continue;
        const source = await readFile(path.join(CLI_ROOT, disposition.sanitizedIn), 'utf8');
        if (!source.includes(SANITIZE_CALL)) unsanitized.push(`${namespace}.${method}`);
      }
    }
    expect(unsanitized).toEqual([]);
  });
});
