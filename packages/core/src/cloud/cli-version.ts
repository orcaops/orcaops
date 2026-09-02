/**
 * Process-wide default CLI release version, attached as the launch-wire
 * `x-orcaops-cli-version` header on every tRPC cloud request the SDK client
 * makes (OAuth discovery/token-exchange calls are a separate surface with no
 * version field). The CLI binary sets it once at program bootstrap. An
 * explicit `cliVersion` on client construction always wins over this default.
 */
let defaultCliVersion: string | null = null;

export function setDefaultCliVersion(version: string): void {
  defaultCliVersion = version;
}

/** Test seam — module-private on purpose (not re-exported from the package). */
export function resetDefaultCliVersion(): void {
  defaultCliVersion = null;
}

export function getDefaultCliVersion(): string | null {
  return defaultCliVersion;
}

export function requireCliVersion(explicit?: string): string {
  const version = explicit ?? defaultCliVersion;
  if (version === null || version.trim().length === 0) {
    throw new Error(
      'A CLI version is required for cloud requests. Set the process default at CLI bootstrap or pass cliVersion explicitly.'
    );
  }
  return version;
}
