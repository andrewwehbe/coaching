import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { listClientSummaries } from '@/lib/clients';

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
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions left this week</h1>
        <p className="text-xs text-faint mt-1">
          {totalLeft} session{totalLeft === 1 ? '' : 's'} owed across {remaining.length} client
          {remaining.length === 1 ? '' : 's'} · {daysLeftInWeek} day
          {daysLeftInWeek === 1 ? '' : 's'} left in week
        </p>
      </header>

      {remaining.length === 0 ? (
        <p className="text-sm text-muted">Everyone&rsquo;s hit their target for the week.</p>
      ) : (
        <ul className="space-y-2">
          {remaining.map((c) => {
            const atRisk = c.sessionsLeft > daysLeftInWeek;
            return (
              <li key={c.id}>
                <Link
                  href={`/coach/clients/${c.id}`}
                  className="block rounded-2xl px-4 py-3.5 border border-border bg-surface/60 hover:border-primary/40 hover:bg-surface transition-all"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-text truncate">{c.name}</p>
                      <p className="text-xs text-faint mt-0.5">
                        {c.daysLoggedThisWeek}/{c.target} done
                        {atRisk && (
                          <span className="ml-2 text-danger">
                            can&rsquo;t hit target
                          </span>
                        )}
                      </p>
                    </div>
                    <span
                      className={`font-semibold tabular-nums text-sm ${
                        atRisk ? 'text-danger' : 'text-warn'
                      }`}
                    >
                      {c.sessionsLeft} left
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
