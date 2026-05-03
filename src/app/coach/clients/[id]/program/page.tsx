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

  const [{ data: client }, { data: activeProgram }] = await Promise.all([
    supa.from('clients').select('id,name').eq('id', id).maybeSingle(),
    supa
      .from('programs')
      .select('id,source_filename,uploaded_at')
      .eq('client_id', id)
      .eq('active', true)
      .order('uploaded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!client) notFound();

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-2xl w-full mx-auto">
      <Link
        href={`/coach/clients/${client.id}`}
        className="text-sm text-muted hover:text-text transition-colors"
      >
        ← {client.name}
      </Link>
      <header className="mt-3 mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Upload program</h1>
        <p className="text-sm text-muted mt-1">
          .xlsx file, last sheet is parsed. Logged values in week columns are
          discarded — clean slate.
        </p>
      </header>

      {activeProgram && (
        <div className="mb-5 rounded-2xl border border-border bg-surface/60 px-4 py-3 text-sm">
          <p className="text-xs uppercase tracking-[0.18em] text-faint">Active program</p>
          <p className="font-medium mt-1">
            {activeProgram.source_filename ?? 'Unnamed'}{' '}
            <span className="text-faint font-normal">
              · {new Date(activeProgram.uploaded_at).toLocaleDateString()}
            </span>
          </p>
          <p className="text-xs text-faint mt-1.5">
            Uploading a new program will mark the current one inactive.
          </p>
        </div>
      )}

      <ProgramUploader clientId={client.id} />
    </main>
  );
}
