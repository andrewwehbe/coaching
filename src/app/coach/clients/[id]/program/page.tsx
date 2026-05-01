import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { readSession } from '@/lib/auth';
import { db } from '@/lib/supabase';

import { ProgramUploader } from './uploader';

type Params = Promise<{ id: string }>;

export default async function ProgramUploadPage(props: { params: Params }) {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'coach') redirect('/today');

  const { id } = await props.params;
  const supa = db();

  const { data: client } = await supa
    .from('clients')
    .select('id,name')
    .eq('id', id)
    .maybeSingle();
  if (!client) notFound();

  const { data: activeProgram } = await supa
    .from('programs')
    .select('id,source_filename,uploaded_at')
    .eq('client_id', id)
    .eq('active', true)
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-2xl w-full mx-auto">
      <header className="mb-6">
        <Link
          href={`/coach/clients/${client.id}`}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          ← {client.name}
        </Link>
        <h1 className="text-2xl font-semibold mt-2">Upload program</h1>
        <p className="text-sm text-neutral-400 mt-1">
          .xlsx file, last sheet is parsed. Logged values in week columns are
          discarded — clean slate.
        </p>
      </header>

      {activeProgram && (
        <div className="mb-5 rounded-xl border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-sm">
          <p className="text-neutral-400">Active program</p>
          <p className="font-medium">
            {activeProgram.source_filename ?? 'Unnamed'}{' '}
            <span className="text-neutral-500">
              · {new Date(activeProgram.uploaded_at).toLocaleDateString()}
            </span>
          </p>
          <p className="text-xs text-neutral-500 mt-1">
            Uploading a new program will mark the current one inactive.
          </p>
        </div>
      )}

      <ProgramUploader clientId={client.id} />
    </main>
  );
}
