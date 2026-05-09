import { redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { buildTodaySchedule } from '@/lib/schedule';
import { LogoutButton } from '@/components/logout-button';
import { NotificationsToggle } from '@/components/notifications-toggle';
import { SwitchToCoachButton } from '@/components/switch-to-coach-button';

// Mirror of /api/client/switch-to-coach so the button only renders for the
// linked client (no point showing "Coach" to other clients).
const LINKED_CLIENT_ID =
  process.env.COACH_LINKED_CLIENT_ID || '8a06a900-aec4-44fc-8da4-9f90581a74c0';
import { LoadInView } from './load-in';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
      rightControls={
        <>
          <NotificationsToggle />
          <Link
            href="/check-in"
            className="text-[10px] uppercase tracking-[0.22em] text-muted hover:text-text transition-colors"
          >
            Check-in
          </Link>
          {user.id === LINKED_CLIENT_ID && <SwitchToCoachButton />}
          <LogoutButton />
        </>
      }
    />
  );
}
