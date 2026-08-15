'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/coach', label: 'Home', match: (p: string) => p === '/coach' },
  { href: '/coach/clients', label: 'Clients', match: (p: string) => p.startsWith('/coach/clients') },
  { href: '/coach/sessions', label: 'Sessions', match: (p: string) => p.startsWith('/coach/sessions') },
  { href: '/coach/check-ins', label: 'Check-ins', match: (p: string) => p.startsWith('/coach/check-ins') },
  { href: '/coach/alerts', label: 'Alerts', match: (p: string) => p.startsWith('/coach/alerts') },
];

export function CoachNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav className="flex items-stretch gap-1 overflow-x-auto no-scrollbar -mx-1 pt-1.5">
      {TABS.map((t) => {
        const active = t.match(pathname);
        // Prefetch stays on: pages are dynamic, so it only preloads the
        // static shell + loading.tsx — data stays request-fresh while
        // taps paint instantly.
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`group relative shrink-0 px-3 sm:px-4 pt-1.5 pb-2.5 text-[11px] uppercase tracking-[0.18em] font-medium transition-colors ${
              active ? 'text-text' : 'text-faint hover:text-text'
            }`}
          >
            {t.label}
            <span
              aria-hidden
              className={`absolute left-3 right-3 sm:left-4 sm:right-4 -bottom-px h-px transition-all ${
                active
                  ? 'bg-primary'
                  : 'bg-transparent group-hover:bg-text/35'
              }`}
            />
          </Link>
        );
      })}
    </nav>
  );
}
