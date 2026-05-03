import { notFound } from 'next/navigation';
import Link from 'next/link';

import { requireCoach } from '@/lib/coach-guard';
import { db } from '@/lib/supabase';
import { ProgramEditor } from './program-editor';

type Params = Promise<{ id: string }>;

export const dynamic = 'force-dynamic';

export default async function EditProgramPage(props: { params: Params }) {
  await requireCoach();
  const { id: clientId } = await props.params;

  const supa = db();
  const [{ data: client }, { data: program }] = await Promise.all([
    supa.from('clients').select('id, name').eq('id', clientId).maybeSingle(),
    supa
      .from('programs')
      .select('id, source_filename')
      .eq('client_id', clientId)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!client) notFound();

  if (!program) {
    return (
      <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
        <Link
          href={`/coach/clients/${clientId}`}
          className="text-sm text-muted hover:text-text transition-colors"
        >
          ← {client.name}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Edit program</h1>
        <p className="mt-4 text-sm text-muted">
          No active program. Upload one first from the client page.
        </p>
      </main>
    );
  }

  const { data: days } = await supa
    .from('days')
    .select('id, day_index, label, exercises(id, position, name, prescription_raw, coach_note, archived_at)')
    .eq('program_id', program.id)
    .order('day_index');

  const initial = (days ?? []).map((d) => ({
    id: d.id,
    label: d.label,
    exercises: (d.exercises ?? [])
      .filter((e) => e.archived_at == null)
      .sort((a, b) => a.position - b.position)
      .map((e) => ({
        id: e.id,
        name: e.name,
        prescription_raw: e.prescription_raw ?? '',
        coach_note: e.coach_note ?? '',
      })),
  }));

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <Link
        href={`/coach/clients/${clientId}`}
        className="text-sm text-muted hover:text-text transition-colors"
      >
        ← {client.name}
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Edit program</h1>
      <p className="mt-1 mb-6 text-xs text-faint">
        Renaming an exercise resets its progress (cue says &ldquo;Log first set&rdquo; until they
        log it again). Removed exercises are archived, not deleted — old history stays intact.
      </p>
      <ProgramEditor clientId={clientId} initial={initial} />
    </main>
  );
}
