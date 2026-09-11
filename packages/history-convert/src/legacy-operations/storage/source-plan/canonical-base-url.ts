export function canonicalizeBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}
