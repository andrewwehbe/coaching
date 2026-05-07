import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { LogoutButton } from '@/components/logout-button';
import { NotificationsToggle } from '@/components/notifications-toggle';
import { SwitchToSelfButton } from '@/components/switch-to-self-button';
import { CoachNav } from './coach-nav';

export const dynamic = 'force-dynamic';

export default async function CoachLayout({ children }: { children: React.ReactNode }) {
  await requireCoach();
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl w-full px-5 pt-3 pb-2 flex items-center justify-between gap-3">
          <Link href="/coach" className="flex items-center gap-2 group shrink-0">
            <span className="h-2.5 w-2.5 rounded-full bg-primary shadow-[0_0_18px_2px_rgba(34,197,94,0.6)]" />
            <span className="font-semibold tracking-tight text-text group-hover:text-primary-hi transition-colors">
              Coach
            </span>
          </Link>
          <div className="flex items-center gap-3 shrink-0">
            <NotificationsToggle />
            <SwitchToSelfButton />
            <LogoutButton />
          </div>
        </div>
        <div className="mx-auto max-w-3xl w-full px-5 pb-3 flex justify-center">
          <CoachNav />
        </div>
      </header>
      {children}
    </div>
  );
}
