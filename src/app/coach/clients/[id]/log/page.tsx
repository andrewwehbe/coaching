import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { LogOnBehalfForm } from './log-form';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function LogOnBehalfPage(props: { params: Params }) {
  await requireCoach();
  const { id } = await props.params;

  const supa = db();
  const { data: client } = await supa
    .from('clients')
    .select('id, name, active')
    .eq('id', id)
    .maybeSingle();
  if (!client) notFound();

  const { data: program } = await supa
    .from('programs')
    .select('id')
    .eq('client_id', id)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: days } = program
    ? await supa
        .from('days')
        .select(
          'id, day_index, label, exercises(id, position, name, prescription_raw, prescribed_sets, is_cardio, archived_at)',
        )
        .eq('program_id', program.id)
        .order('day_index')
    : { data: [] as never };

  const dayPayload = (days ?? [])
    .map((d) => ({
      id: d.id,
      day_index: d.day_index,
      label: d.label,
      exercises: (d.exercises ?? [])
        .filter((e) => e.archived_at == null)
        .sort((a, b) => a.position - b.position)
        .map((e) => ({
          id: e.id,
          name: e.name,
          prescription_raw: e.prescription_raw,
          prescribed_sets: e.prescribed_sets,
          is_cardio: e.is_cardio,
        })),
    }))
    .sort((a, b) => a.day_index - b.day_index);

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-2xl w-full mx-auto">
      <header className="mb-6">
        <Link
          href={`/coach/clients/${client.id}`}
          className="text-sm text-neutral-400 hover:text-neutral-200"
        >
          ← {client.name}
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Log on behalf</h1>
        <p className="text-sm text-neutral-400 mt-1">
          Pick a day and fill in the sets the client did.
        </p>
      </header>

      {dayPayload.length === 0 ? (
        <p className="rounded-xl border border-neutral-800 bg-neutral-900/30 px-4 py-3 text-sm text-neutral-400">
          This client has no active program. Upload one first.
        </p>
      ) : (
        <LogOnBehalfForm clientId={client.id} days={dayPayload} />
      )}
    </main>
  );
}
