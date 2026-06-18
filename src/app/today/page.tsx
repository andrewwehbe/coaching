import { redirect } from 'next/navigation';

import { readSession } from '@/lib/auth';
import { buildTodaySchedule } from '@/lib/schedule';
import { linkForClient } from '@/lib/coach-link';
import { getCheckInStatus } from '@/lib/check-in-status';
import { db } from '@/lib/supabase';
import { HeaderMenu } from '@/components/header-menu';
import { FeatureAnnounce } from '@/components/feature-announce';
import { LoadInView } from './load-in';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Rollout gate for the "Add a note to self" announcement. While this holds
// client ids, only those clients see the popup. To release to everyone, set
// ANNOUNCE_TO_EVERYONE = true (the allowlist is then ignored).
const ANNOUNCE_TO_EVERYONE = false;
const ANNOUNCE_CLIENT_IDS = new Set<string>([
  '8a06a900-aec4-44fc-8da4-9f90581a74c0', // Andrew (test first)
]);

export default async function TodayPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type === 'coach') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const announceEnabled = ANNOUNCE_TO_EVERYONE || ANNOUNCE_CLIENT_IDS.has(user.id);

  const supa = db();
  const { data: clientRow } = await supa
    .from('clients')
    .select('body_weight_freq, photo_check_in_enabled')
    .eq('id', user.id)
    .maybeSingle();

  const [schedule, link, checkIn] = await Promise.all([
    buildTodaySchedule(user.id),
    linkForClient(user.id),
    getCheckInStatus({
      id: user.id,
      body_weight_freq: (clientRow?.body_weight_freq ?? 'none') as 'none' | 'daily' | '3x' | 'weekly',
      photo_check_in_enabled: clientRow?.photo_check_in_enabled ?? false,
    }),
  ]);

  if (!schedule.programId) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center space-y-4">
        <FeatureAnnounce enabled={announceEnabled} />
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
    <>
      <FeatureAnnounce enabled={announceEnabled} />
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
      checkIn={checkIn.enabled ? { due: checkIn.due, period: checkIn.period, done: checkIn.done, target: checkIn.target } : null}
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
    </>
  );
}
