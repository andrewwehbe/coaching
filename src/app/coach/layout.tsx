import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { HeaderMenu } from '@/components/header-menu';
import { PushPrompt } from '@/components/push-prompt';
import { linkForCoach } from '@/lib/coach-link';
import { CoachNav } from './coach-nav';

export const dynamic = 'force-dynamic';

export default async function CoachLayout({ children }: { children: React.ReactNode }) {
  const user = await requireCoach();
  const link = await linkForCoach(user.id);
  return (
    <div className="relative flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/85 backdrop-blur-xl">
        <div className="mx-auto max-w-5xl w-full px-5 sm:px-8 pt-3 pb-1.5 flex items-center justify-between gap-4">
          <Link href="/coach" className="flex items-baseline gap-3 group shrink-0">
            <span className="h-2 w-2 rounded-full bg-primary shadow-[0_0_14px_2px_rgba(34,197,94,0.55)] self-center" />
            <span className="font-display text-[15px] tracking-[0.3em] uppercase text-text group-hover:text-primary-hi transition-colors">
              Coach
            </span>
          </Link>
          <HeaderMenu
            switchKind={link ? 'switch-to-self' : null}
            switchLabel="My account"
          />
        </div>
        <div className="mx-auto max-w-5xl w-full px-5 sm:px-8">
          <CoachNav />
        </div>
      </header>
      {/* Push enrollment for pain / missed-workout / check-in alerts. The
          component was built but never mounted anywhere, so coaches were
          never asked. empty:hidden collapses the wrapper when it renders
          null (already granted/denied/dismissed). */}
      <div className="mx-auto max-w-5xl w-full px-5 sm:px-8 pt-4 empty:hidden">
        <PushPrompt />
      </div>
      {children}
    </div>
  );
}
