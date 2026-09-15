import { notFound, redirect } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { buildTodaySchedule } from '@/lib/schedule';
import { PageHeader } from '../../../ui';
import { TrainPicker } from './train-picker';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

/**
 * The coach's version of /today for a PT client: pick a session, then the
 * normal client logger opens at /workout/[id] running on the coach session.
 */
export default async function TrainPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, active, client_type')
    .eq('id', id)
    .maybeSingle();
  if (!client) notFound();
  if (client.client_type !== 'pt' || !client.active) redirect(`/coach/clients/${id}`);

  const schedule = await buildTodaySchedule(id);

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-md w-full mx-auto">
      <PageHeader
        back={{ href: `/coach/clients/${id}`, label: client.name }}
        eyebrow={schedule.isDeloadWeek ? 'This week · deload' : 'This week'}
        title="Train"
      />

      {!schedule.programId ? (
        <p className="text-sm text-muted">No active program. Build one first.</p>
      ) : (
        <TrainPicker
          clientId={id}
          days={schedule.days}
          suggestedDayId={schedule.suggested?.dayId ?? null}
        />
      )}
    </main>
  );
}
