import { notFound } from 'next/navigation';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { PageHeader } from '../../../ui';
import { BaselinesForm } from './baselines-form';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function BaselinesPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;
  const supa = db();

  const [{ data: client }, { data: program }] = await Promise.all([
    supa.from('clients').select('id, name').eq('id', id).maybeSingle(),
    supa
      .from('programs')
      .select('id, training_start_at, uploaded_at')
      .eq('client_id', id)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!client) notFound();

  if (!program) {
    return (
      <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
        <PageHeader
          back={{ href: `/coach/clients/${id}`, label: 'Back to client' }}
          eyebrow="Baselines"
          title={client.name}
        />
        <p className="rounded-2xl border border-border bg-surface/40 px-4 py-3 text-sm text-muted">
          No active program — upload one first.
        </p>
      </main>
    );
  }

  const { data: dayRows } = await supa
    .from('days')
    .select('day_index, label, exercises(id, name, name_key, archived_at, is_cardio, position)')
    .eq('program_id', program.id)
    .order('day_index');

  type ExRow = {
    id: string;
    name: string;
    name_key: string;
    archived_at: string | null;
    is_cardio: boolean;
    position: number;
  };

  // Group by name_key (one input per logical exercise, even if it lives on
  // multiple days). Cardio is excluded — the cue / best_efforts model only
  // applies to weighted lifts.
  const byKey = new Map<
    string,
    { name_key: string; display_name: string; days: number[]; min_position: number }
  >();
  for (const d of dayRows ?? []) {
    const exes = (d.exercises ?? []) as ExRow[];
    for (const ex of exes) {
      if (ex.archived_at || ex.is_cardio) continue;
      const cur = byKey.get(ex.name_key);
      if (cur) {
        if (!cur.days.includes(d.day_index)) cur.days.push(d.day_index);
        cur.min_position = Math.min(cur.min_position, ex.position);
      } else {
        byKey.set(ex.name_key, {
          name_key: ex.name_key,
          display_name: ex.name,
          days: [d.day_index],
          min_position: ex.position,
        });
      }
    }
  }

  // Sort: by first day_index, then position.
  const exercises = Array.from(byKey.values())
    .map((e) => ({ ...e, days: e.days.sort((a, b) => a - b) }))
    .sort((a, b) => {
      const da = a.days[0] ?? 99;
      const db_ = b.days[0] ?? 99;
      if (da !== db_) return da - db_;
      return a.min_position - b.min_position;
    });

  // Existing best_efforts so the form can pre-fill.
  const { data: existingBests } = await supa
    .from('best_efforts')
    .select('exercise_name_key, best_weight, best_unit, best_reps')
    .eq('client_id', id)
    .in('exercise_name_key', exercises.map((e) => e.name_key));

  const bestsByKey = new Map(
    (existingBests ?? []).map((b) => [
      b.exercise_name_key,
      {
        weight: b.best_weight == null ? '' : String(b.best_weight),
        unit: (b.best_unit as 'kg' | 'lb' | null) ?? 'kg',
        reps: b.best_reps == null ? '' : String(b.best_reps),
      },
    ]),
  );

  const initialTrainingStart = program.training_start_at
    ? format(new Date(program.training_start_at), 'yyyy-MM-dd')
    : '';

  return (
    <main className="flex flex-1 flex-col px-5 sm:px-8 py-7 max-w-3xl w-full mx-auto">
      <PageHeader
        back={{ href: `/coach/clients/${id}`, label: 'Back to client' }}
        eyebrow="Baselines"
        title={client.name}
      />

      <p className="text-sm text-muted mb-6 max-w-prose">
        For clients who transitioned mid-mesocycle from elsewhere — set the date
        their training block actually started so the plateau engine doesn&rsquo;t
        treat them as week 1, and import their starting bests so the cue shows
        the right target from session 1 instead of &ldquo;Log first set&rdquo;.
      </p>

      <BaselinesForm
        clientId={client.id}
        initialTrainingStart={initialTrainingStart}
        exercises={exercises.map((e) => ({
          name_key: e.name_key,
          display_name: e.display_name,
          days: e.days,
          existing: bestsByKey.get(e.name_key) ?? { weight: '', unit: 'kg', reps: '' },
        }))}
      />
    </main>
  );
}
