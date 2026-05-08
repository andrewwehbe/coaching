import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries } from '@/lib/clients';
import { PageHeader } from '../../ui';

export const dynamic = 'force-dynamic';

export default async function RemainingSessionsPage() {
  await requireCoach();
  const summaries = await listClientSummaries();

  const now = new Date();
  // Mon=0 … Sun=6.
  const dow = (now.getDay() + 6) % 7;
  const daysLeftInWeek = 6 - dow;

  const remaining = summaries
    .filter((c) => c.active)
    .map((c) => {
      const target = c.weeklyDayTarget ?? 4;
      const left = Math.max(0, target - c.daysLoggedThisWeek);
      return { ...c, target, sessionsLeft: left };
    })
    .filter((c) => c.sessionsLeft > 0)
    .sort((a, b) => b.sessionsLeft - a.sessionsLeft || a.name.localeCompare(b.name));

  const totalLeft = remaining.reduce((sum, c) => sum + c.sessionsLeft, 0);

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-5xl w-full mx-auto">
      <PageHeader
        back={{ href: '/coach', label: 'Home' }}
        eyebrow="The list"
        title="Sessions left"
        meta={
          <span>
            <span className="font-mono tabular-nums text-muted">{totalLeft}</span>{' '}
            session{totalLeft === 1 ? '' : 's'} owed across{' '}
            <span className="font-mono tabular-nums text-muted">{remaining.length}</span>{' '}
            client{remaining.length === 1 ? '' : 's'}
            <span className="mx-2 text-border-strong">·</span>
            <span className="font-mono tabular-nums text-muted">{daysLeftInWeek}</span> day
            {daysLeftInWeek === 1 ? '' : 's'} left in week
          </span>
        }
      />

      {remaining.length === 0 ? (
        <div className="border-t border-border pt-10 text-center">
          <p className="font-display text-3xl text-primary-hi">
            Everyone&rsquo;s hit target.
          </p>
          <p className="mt-2 text-[11px] uppercase tracking-[0.22em] text-faint">
            See you Monday.
          </p>
        </div>
      ) : (
        <ul className="border-t border-border">
          {remaining.map((c) => {
            const atRisk = c.sessionsLeft > daysLeftInWeek;
            return (
              <li key={c.id} className="border-b border-border">
                <Link
                  href={`/coach/clients/${c.id}`}
                  prefetch={false}
                  className="group flex items-baseline justify-between gap-4 px-2 py-4 hover:bg-surface/40 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-2xl sm:text-3xl tracking-tight leading-none truncate group-hover:text-primary-hi transition-colors">
                      {c.name}
                    </p>
                    <p className="mt-1.5 text-[10px] sm:text-[11px] uppercase tracking-[0.18em] text-faint">
                      <span className="tabular-nums text-muted">
                        {c.daysLoggedThisWeek}/{c.target}
                      </span>{' '}
                      done
                      {atRisk && (
                        <>
                          <span className="mx-2 text-border-strong">·</span>
                          <span className="text-danger">can&rsquo;t hit target</span>
                        </>
                      )}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 font-display text-3xl sm:text-4xl tabular-nums leading-none tracking-tight ${
                      atRisk ? 'text-danger' : 'text-warn'
                    }`}
                  >
                    {c.sessionsLeft}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
