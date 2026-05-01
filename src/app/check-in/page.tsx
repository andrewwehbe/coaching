import { redirect } from 'next/navigation';
import { format } from 'date-fns';

import { readSession } from '@/lib/auth';
import { db, signMediaUrls } from '@/lib/supabase';
import { LogoutButton } from '@/components/logout-button';
import { CheckInForm } from './check-in-form';

const PHOTO_BUCKET = 'check-in-photos';

export const dynamic = 'force-dynamic';

export default async function CheckInPage() {
  const user = await readSession();
  if (!user) redirect('/login');
  if (user.type !== 'client') redirect('/coach');
  if (!user.active) redirect('/deactivated');

  const supa = db();
  const { data: recent } = await supa
    .from('check_ins')
    .select('id, date, body_weight, body_weight_unit, notes, check_in_photos(id, label, storage_url)')
    .eq('client_id', user.id)
    .order('date', { ascending: false })
    .limit(6);

  const last = recent?.[0] ?? null;
  const lastUnit = (last?.body_weight_unit as 'kg' | 'lb' | null) ?? 'kg';

  // Batch-sign all photo paths (storage_url now holds a path, not a URL).
  const photoPaths: string[] = [];
  for (const c of recent ?? []) {
    const ph = (c.check_in_photos as Array<{ storage_url: string }>) ?? [];
    for (const p of ph) photoPaths.push(p.storage_url);
  }
  const signed = await signMediaUrls(PHOTO_BUCKET, photoPaths);
  const signedByPath = new Map<string, string | null>();
  photoPaths.forEach((p, i) => signedByPath.set(p, signed[i]));

  return (
    <main className="flex flex-1 flex-col px-5 py-6 max-w-md w-full mx-auto">
      <header className="flex items-center justify-between mb-7">
        <div>
          <p className="text-sm text-muted">Check-in</p>
          <h1 className="text-2xl font-semibold tracking-tight">{user.name}</h1>
        </div>
        <LogoutButton />
      </header>

      <CheckInForm defaultUnit={lastUnit} />

      {recent && recent.length > 0 && (
        <section className="mt-8">
          <p className="text-xs uppercase tracking-[0.18em] text-faint mb-3">Recent check-ins</p>
          <ul className="space-y-2">
            {recent.map((c) => {
              const photos = (c.check_in_photos as Array<{
                id: string;
                label: string;
                storage_url: string;
              }>) ?? [];
              return (
                <li
                  key={c.id}
                  className="rounded-2xl border border-border bg-surface/60 px-4 py-3"
                >
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-medium text-text">
                      {format(new Date(c.date + 'T00:00:00'), 'EEE, MMM d')}
                    </p>
                    <p className="text-sm tabular-nums text-muted">
                      {c.body_weight != null
                        ? `${c.body_weight}${(c.body_weight_unit ?? 'kg').toUpperCase()}`
                        : '—'}
                    </p>
                  </div>
                  {c.notes && <p className="text-xs text-muted mb-2">{c.notes}</p>}
                  {photos.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto -mx-1 px-1">
                      {photos.map((p) => {
                        const url = signedByPath.get(p.storage_url) ?? null;
                        if (!url) return null;
                        return (
                          <a
                            key={p.id}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block shrink-0 rounded-lg overflow-hidden border border-border"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={url}
                              alt={p.label}
                              className="h-16 w-16 object-cover"
                              loading="lazy"
                            />
                          </a>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
