import { redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { buildTodaySchedule } from '@/lib/schedule';
import { LogoutButton } from '@/components/logout-button';
import { BeginButton } from './begin-button';

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
        <p className="text-neutral-400 text-sm max-w-xs">
          Your coach hasn&apos;t set up your program. Check back soon.
        </p>
        <LogoutButton />
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-neutral-400">Hey,</p>
          <h1 className="text-2xl font-semibold">{user.name}</h1>
        </div>
        <LogoutButton />
      </header>

      {schedule.threeInARowWarning && (
        <div className="mb-5 rounded-xl border border-amber-700/50 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          <strong>Heads up:</strong> you&apos;ve trained the last 2 days. Three days in
          a row isn&apos;t recommended — but you can start anyway from the workout screen.
        </div>
      )}

      <ol className="space-y-2 mb-6">
        {schedule.days.map((d) => {
          const isSuggested = schedule.suggested?.dayId === d.dayId;
          return (
            <li
              key={d.dayId}
              className={`rounded-xl px-4 py-3 border transition-colors ${
                isSuggested
                  ? 'border-emerald-600/60 bg-emerald-950/30'
                  : 'border-neutral-800 bg-neutral-900/40'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    {d.label.split(' - ')[0] ?? `Day ${d.dayIndex}`}
                  </p>
                  <p className="font-medium">
                    {d.label.split(' - ').slice(1).join(' - ') || d.label}
                  </p>
                </div>
                <StatusChip status={d.status} />
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
        <p className="text-center text-neutral-400 text-sm">
          You&apos;ve done every day this week. Nice.
        </p>
      )}
    </main>
  );
}

function StatusChip({ status }: { status: 'done' | 'upcoming' | 'in_progress' }) {
  if (status === 'done') {
    return (
      <span className="text-xs px-2 py-1 rounded-full bg-emerald-900/60 text-emerald-300 border border-emerald-700/40">
        Done
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="text-xs px-2 py-1 rounded-full bg-amber-900/60 text-amber-200 border border-amber-700/40">
        In progress
      </span>
    );
  }
  return (
    <span className="text-xs px-2 py-1 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
      Upcoming
    </span>
  );
}
