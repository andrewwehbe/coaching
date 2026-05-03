import Link from 'next/link';
import { format } from 'date-fns';

import { requireCoach } from '@/lib/coach-guard';
import { db, signMediaUrls } from '@/lib/supabase';

const PHOTO_BUCKET = 'check-in-photos';

export const dynamic = 'force-dynamic';

export default async function CheckInsPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  await requireCoach();
  const { client: clientFilter } = await searchParams;

  const supa = db();

  let checkInQuery = supa
    .from('check_ins')
    .select('id, client_id, date, body_weight, body_weight_unit, notes, clients(name), check_in_photos(id, label, storage_url)')
    .order('date', { ascending: false })
    .limit(120);
  if (clientFilter) checkInQuery = checkInQuery.eq('client_id', clientFilter);

  const [{ data: clients }, { data: rows }] = await Promise.all([
    supa
      .from('clients')
      .select('id, name, body_weight_freq, photo_check_in_enabled')
      .eq('active', true)
      .order('name'),
    checkInQuery,
  ]);

  const photoPaths: string[] = [];
  for (const r of rows ?? []) {
    const ph = (r.check_in_photos as Array<{ storage_url: string }>) ?? [];
    for (const p of ph) photoPaths.push(p.storage_url);
  }
  const signed = photoPaths.length ? await signMediaUrls(PHOTO_BUCKET, photoPaths) : [];
  const signedByPath = new Map<string, string>();
  photoPaths.forEach((p, i) => {
    if (signed[i]) signedByPath.set(p, signed[i]!);
  });

  // Latest body weight per client (for the strip at the top).
  const latestByClient = new Map<string, { weight: number; unit: string; date: string }>();
  for (const r of rows ?? []) {
    if (r.body_weight == null) continue;
    if (!latestByClient.has(r.client_id)) {
      latestByClient.set(r.client_id, {
        weight: Number(r.body_weight),
        unit: r.body_weight_unit ?? 'kg',
        date: r.date,
      });
    }
  }

  return (
    <main className="flex flex-1 flex-col px-5 py-7 max-w-3xl w-full mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight">Check-ins</h1>

      <div className="mt-5 mb-5 flex flex-wrap gap-1.5 text-sm">
        <Link
          href="/coach/check-ins"
          className={`px-3 py-1.5 rounded-full border font-medium transition-colors ${
            !clientFilter
              ? 'border-primary/50 bg-primary/10 text-primary-hi'
              : 'border-border text-muted hover:text-text hover:border-border-strong'
          }`}
        >
          Everyone
        </Link>
        {(clients ?? []).map((c) => {
          const latest = latestByClient.get(c.id);
          return (
            <Link
              key={c.id}
              href={`/coach/check-ins?client=${c.id}`}
              className={`px-3 py-1.5 rounded-full border font-medium transition-colors ${
                clientFilter === c.id
                  ? 'border-primary/50 bg-primary/10 text-primary-hi'
                  : 'border-border text-muted hover:text-text hover:border-border-strong'
              }`}
            >
              {c.name}
              {latest && (
                <span className="ml-1.5 text-faint tabular-nums">
                  {latest.weight}{(latest.unit ?? 'kg').toUpperCase()}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {(rows ?? []).length === 0 ? (
        <p className="text-sm text-muted">No check-ins yet{clientFilter ? ' for this client' : ''}.</p>
      ) : (
        <ul className="space-y-2">
          {(rows ?? []).map((r) => {
            const cs = r.clients as unknown;
            const c = (Array.isArray(cs) ? cs[0] : cs) as { name?: string } | null;
            const photos = (r.check_in_photos as Array<{ id: string; label: string; storage_url: string }>) ?? [];
            return (
              <li key={r.id} className="rounded-2xl border border-border bg-surface/60 px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-text">
                    {c?.name ?? '(unknown)'}
                    <span className="text-faint font-normal ml-2">
                      {format(new Date(r.date + 'T00:00:00'), 'EEE, MMM d')}
                    </span>
                  </p>
                  <p className="text-sm tabular-nums text-muted">
                    {r.body_weight != null
                      ? `${r.body_weight}${(r.body_weight_unit ?? 'kg').toUpperCase()}`
                      : '—'}
                  </p>
                </div>
                {r.notes && <p className="text-xs text-muted mb-2">{r.notes}</p>}
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
                            className="h-20 w-20 object-cover"
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
      )}
    </main>
  );
}
