import { redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { buildTodaySchedule } from '@/lib/schedule';
import { LogoutButton } from '@/components/logout-button';
import { NotificationsToggle } from '@/components/notifications-toggle';
import { BeginButton } from './begin-button';
import { MissedButton } from './missed-button';

export default async function TodayPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type === 'coach') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const schedule = await buildTodaySchedule(user.id);

  if (!schedule.programId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <h1 className="text-xl font-semibold">No program yet</h1>
        <p className="text-muted text-sm max-w-xs">
          Your coach hasn&apos;t set up your program. Check back soon.
        </p>
        <LogoutButton />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="mb-7">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted">Hey,</p>
            <h1 className="text-2xl font-semibold tracking-tight truncate">{user.greetingName}</h1>
          </div>
          <NotificationsToggle />
        </div>
        <div className="mt-3 flex items-center justify-end gap-4">
          <Link
            href="/check-in"
            className="text-sm text-muted hover:text-text transition-colors"
          >
            Check-in
          </Link>
          <LogoutButton />
        </div>
      </header>

      {schedule.threeInARowWarning && (
        <div className="mb-5 rounded-xl border border-warn/35 bg-warn/10 px-4 py-3 text-sm text-warn">
          <strong className="font-semibold">Heads up:</strong> you&apos;ve trained the last 2 days. Three days in
          a row isn&apos;t recommended — but you can start anyway from the workout screen.
        </div>
      )}

      <p className="text-xs uppercase tracking-[0.18em] text-faint mb-3">This week</p>
      <ol className="space-y-2 mb-7">
        {schedule.days.map((d) => {
          const isSuggested = schedule.suggested?.dayId === d.dayId;
          return (
            <li
              key={d.dayId}
              className={`rounded-2xl px-4 py-3.5 border transition-all ${
                isSuggested
                  ? 'border-primary/50 bg-primary/8 shadow-[0_0_30px_-12px_rgba(34,197,94,0.6)]'
                  : 'border-border bg-surface/60'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className={`text-xs uppercase tracking-wide ${isSuggested ? 'text-primary-hi' : 'text-faint'}`}>
                    {d.label.split(' - ')[0] ?? `Day ${d.dayIndex}`}
                  </p>
                  <p className="font-medium text-text">
                    {d.label.split(' - ').slice(1).join(' - ') || d.label}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusChip status={d.status} />
                  {d.status === 'upcoming' && <MissedButton dayId={d.dayId} label={d.label} />}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {schedule.suggested ? (
        <BeginButton
          dayId={schedule.suggested.dayId}
          dayLabel={schedule.suggested.label}
          warn={schedule.threeInARowWarning}
          existingWorkoutId={schedule.suggested.workoutId ?? null}
        />
      ) : (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 px-4 py-5 text-center">
          <p className="text-sm text-primary-hi font-medium">All done this week. Nice.</p>
        </div>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: 'done' | 'upcoming' | 'in_progress' | 'missed' }) {
  if (status === 'done') {
    return (
      <span className="text-xs px-2.5 py-1 rounded-full bg-primary/15 text-primary-hi border border-primary/30 font-medium">
        Done
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="text-xs px-2.5 py-1 rounded-full bg-accent/10 text-accent border border-accent/30 font-medium">
        In progress
      </span>
    );
  }
  if (status === 'missed') {
    return (
      <span className="text-xs px-2.5 py-1 rounded-full bg-warn/10 text-warn border border-warn/30 font-medium">
        Missed
      </span>
    );
  }
  return (
    <span className="text-xs px-2.5 py-1 rounded-full bg-surface-2 text-muted border border-border">
      Upcoming
    </span>
  );
}
