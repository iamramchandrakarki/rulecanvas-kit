import type { MouseEvent } from 'react';

export interface WorkbenchNavLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly description?: string | undefined;
}

export interface WorkbenchNavigationProps {
  readonly current: string;
  readonly links: readonly WorkbenchNavLink[];
  readonly allowedPrefix?: string | undefined;
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
  readonly listClassName?: string | undefined;
  readonly linkClassName?: string | undefined;
  readonly activeLinkClassName?: string | undefined;
  readonly onNavigate?: ((link: WorkbenchNavLink, event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
}

/**
 * Validates that a navigation href is a safe same-origin relative path
 * (rejecting cross-origin URLs, protocol-relative URLs, javascript:/data: schemes,
 * and paths outside an optional configured deployment prefix).
 */
export function isSafeSameOriginNavigationHref(href: string, allowedPrefix?: string): boolean {
  const trimmed = href.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('//')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return false;

  try {
    const base = new URL('https://rulecanvas.local/app/');
    const resolved = new URL(trimmed, base);
    if (resolved.origin !== base.origin) return false;
    if (allowedPrefix !== undefined && allowedPrefix.length > 0) {
      const normalizedPrefix = allowedPrefix.startsWith('/') ? allowedPrefix : `/${allowedPrefix}`;
      if (!resolved.pathname.startsWith(normalizedPrefix)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function WorkbenchNavigation({
  current,
  links,
  allowedPrefix,
  ariaLabel = 'Workbench switcher',
  className,
  listClassName,
  linkClassName,
  activeLinkClassName,
  onNavigate,
}: WorkbenchNavigationProps) {
  const safeLinks = links.filter((link) => isSafeSameOriginNavigationHref(link.href, allowedPrefix));

  return (
    <nav className={className} aria-label={ariaLabel}>
      <ul className={listClassName}>
        {safeLinks.map((link) => {
          const isActive = link.id === current;
          const combinedClass = [linkClassName, isActive ? activeLinkClassName : undefined]
            .filter(Boolean)
            .join(' ');
          return (
            <li key={link.id}>
              <a
                href={link.href}
                aria-current={isActive ? 'page' : undefined}
                title={link.description}
                className={combinedClass || undefined}
                onClick={(event) => {
                  if (isActive) {
                    event.preventDefault();
                    return;
                  }
                  onNavigate?.(link, event);
                }}
              >
                {link.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
