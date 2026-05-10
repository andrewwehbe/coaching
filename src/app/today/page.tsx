import { redirect } from 'next/navigation';

import { readSession } from '@/lib/auth';
import { buildTodaySchedule } from '@/lib/schedule';
import { linkForClient } from '@/lib/coach-link';
import { HeaderMenu } from '@/components/header-menu';
import { LoadInView } from './load-in';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function TodayPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type === 'coach') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const [schedule, link] = await Promise.all([
    buildTodaySchedule(user.id),
    linkForClient(user.id),
  ]);

  if (!schedule.programId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <h1 className="text-xl font-semibold">No program yet</h1>
        <p className="text-muted text-sm max-w-xs">
          Your coach hasn&apos;t set up your program. Check back soon.
        </p>
        <HeaderMenu
          switchKind={link ? 'switch-to-coach' : null}
          switchLabel="Coach"
        />
      </main>
    );
  }

  // All clients get the barbell load-in experience now.
  return (
    <LoadInView
      greetingName={user.greetingName}
      days={schedule.days.map((d) => ({
        dayId: d.dayId,
        dayIndex: d.dayIndex,
        label: d.label,
        status: d.status,
        workoutId: d.workoutId ?? null,
      }))}
      suggested={
        schedule.suggested
          ? {
              dayId: schedule.suggested.dayId,
              label: schedule.suggested.label,
              workoutId: schedule.suggested.workoutId ?? null,
            }
          : null
      }
      threeInARowWarning={schedule.threeInARowWarning}
      isDeloadWeek={schedule.isDeloadWeek}
      rightControls={
        <HeaderMenu
          switchKind={link ? 'switch-to-coach' : null}
          switchLabel="Coach"
          links={[
            { href: '/trends', label: 'Trends' },
            { href: '/check-in', label: 'Check-in' },
          ]}
        />
      }
    />
  );
}
