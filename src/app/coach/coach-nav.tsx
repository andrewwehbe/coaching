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
    <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
              active
                ? 'bg-primary/15 text-primary-hi border border-primary/30 shadow-[0_0_0_1px_rgba(34,197,94,0.05)]'
                : 'text-muted hover:text-text hover:bg-surface/60 border border-transparent'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
