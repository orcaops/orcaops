/**
 * Shared byte scan for a JavaScript bundle or a single-file executable that
 * must not carry a native addon inlined from the build machine.
 *
 * What it can prove: the bytes contain neither the recorded build checkout's
 * path nor the shape a bundled addon loader leaves behind. What it cannot
 * prove: that a bundler did not inline an addon through some path this list
 * does not name, or that the executable resolves the addon correctly at run
 * time on another machine. It is a tripwire on the one failure that has
 * actually happened, not a proof of correct packaging.
 *
 * The checkout path alone is not enough. A release commonly assembles
 * executables built in a DIFFERENT checkout (SKIP_COMPILE=1 with a CI
 * artifact), where scanning for the assembling machine's own root matches
 * nothing and passes for the wrong reason. So the compile records the checkout
 * it built in, the release scans for THAT value, and both also scan for a
 * path-independent signature that survives any checkout.
 */

/**
 * Fragments a bundled native addon loader leaves in the bytes regardless of
 * where it was built. better-sqlite3's `lib/binding.js` closes over its own
 * `__dirname` and resolves `prebuilds/<platform>-<arch>.node`; an external
 * dependency leaves only its bare specifier, never a path into node_modules.
 */
export const INLINED_ADDON_SIGNATURES = [
  'node_modules/better-sqlite3/lib',
  'node_modules/@napi-rs/keyring',
  '/prebuilds/',
];

/**
 * Every reason the bytes look like they inlined a native addon, as messages.
 * `checkout` is the build root the artifact was produced in — the recorded one
 * for a released executable, the current one for a bundle built here. Pass
 * null when no checkout is known rather than silently scanning for nothing.
 */
export function embeddedAddonFindings(bytes, { checkout }) {
  const findings = [];
  if (checkout !== null && checkout !== undefined && bytes.includes(checkout)) {
    findings.push(`embeds the build checkout path ${checkout}`);
  }
  for (const signature of INLINED_ADDON_SIGNATURES) {
    if (bytes.includes(signature)) findings.push(`embeds an inlined native addon (${signature})`);
  }
  return findings;
}
