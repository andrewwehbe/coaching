import { redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

import { SwapInbox } from './swap-inbox';

type Proposal = {
  id: string;
  client_id: string;
  client_name: string;
  exercise_id: string;
  exercise_name: string;
  exercise_name_key: string;
  day_id: string;
  day_label: string;
  reason: string | null;
  proposed_at: string;
  alternatives: { id: string; name: string }[];
};

export default async function SwapsPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'coach') redirect('/today');

  const supa = db();

  const { data: proposals } = await supa
    .from('swap_proposals')
    .select('id,client_id,exercise_id,reason,proposed_at')
    .eq('status', 'pending')
    .order('proposed_at', { ascending: false });

  const list = proposals ?? [];
  const clientIds = Array.from(new Set(list.map((p) => p.client_id)));
  const exerciseIds = Array.from(new Set(list.map((p) => p.exercise_id)));

  const [{ data: clients }, { data: exercises }] = await Promise.all([
    clientIds.length
      ? supa.from('clients').select('id,name').in('id', clientIds)
      : Promise.resolve({ data: [] }),
    exerciseIds.length
      ? supa
          .from('exercises')
          .select('id,name,name_key,day_id')
          .in('id', exerciseIds)
      : Promise.resolve({ data: [] }),
  ]);

  const clientById = new Map<string, { id: string; name: string }>(
    (clients ?? []).map((c) => [c.id, c])
  );
  const exerciseById = new Map<
    string,
    { id: string; name: string; name_key: string; day_id: string }
  >((exercises ?? []).map((e) => [e.id, e]));

  const dayIds = Array.from(
    new Set(Array.from(exerciseById.values()).map((e) => e.day_id))
  );
  const { data: days } = dayIds.length
    ? await supa.from('days').select('id,label').in('id', dayIds)
    : { data: [] };
  const dayById = new Map<string, { id: string; label: string }>(
    (days ?? []).map((d) => [d.id, d])
  );

  const { data: dayExercises } = dayIds.length
    ? await supa
        .from('exercises')
        .select('id,name,name_key,day_id,archived_at')
        .in('day_id', dayIds)
    : { data: [] };

  const enriched: Proposal[] = list.flatMap((p) => {
    const client = clientById.get(p.client_id);
    const ex = exerciseById.get(p.exercise_id);
    if (!client || !ex) return [];
    const day = dayById.get(ex.day_id);
    const alternatives = (dayExercises ?? [])
      .filter(
        (e) =>
          e.day_id === ex.day_id &&
          e.id !== ex.id &&
          !e.archived_at &&
          e.name_key !== ex.name_key
      )
      .map((e) => ({ id: e.id, name: e.name }));
    return [
      {
        id: p.id,
        client_id: client.id,
        client_name: client.name,
        exercise_id: ex.id,
        exercise_name: ex.name,
        exercise_name_key: ex.name_key,
        day_id: ex.day_id,
        day_label: day?.label ?? 'Day',
        reason: p.reason,
        proposed_at: p.proposed_at,
        alternatives,
      },
    ];
  });

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-2xl w-full mx-auto">
      <header className="mb-6">
        <Link
          href="/coach"
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ← Coach
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Swap proposals</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Exercises stalled long enough to warrant replacement.
        </p>
      </header>

      {enriched.length === 0 ? (
        <p className="text-sm text-neutral-500 text-center py-12">
          No pending swap proposals.
        </p>
      ) : (
        <SwapInbox proposals={enriched} />
      )}
    </main>
  );
}
