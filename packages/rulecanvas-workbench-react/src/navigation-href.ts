export function resolveSameOriginNavigationHref(href: string, baseHref: string): URL | null {
  const trimmed = href.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('\\')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;

  try {
    const base = new URL(baseHref);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    const resolved = new URL(trimmed, base);
    return resolved.origin === base.origin && resolved.protocol === base.protocol ? resolved : null;
  } catch {
    return null;
  }
}
