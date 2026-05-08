/**
 * Stale-workout reminder cron.
 *
 * Schedule: every 30 minutes (see vercel.json). For every active client
 * workout that started 2h+ ago but isn't marked done or missed, send a
 * one-shot reminder push to the client and a coach alert/push so the
 * coach can text them.
 *
 * Trigger conditions (all must hold):
 *  - workouts.started_at <= now() - 2h
 *  - workouts.started_at >= now() - 24h    (skip ancient orphans)
 *  - workouts.completed_at IS NULL
 *  - workouts.is_missed = false
 *  - no prior 'workout_stale' alert for this workout_id
 *
 * Idempotency: keyed on alerts.data->>'workout_id'. Cron retries / dup
 * fires for the same workout no-op.
 */
import { NextResponse } from 'next/server';
import { db } from '@/lib/supabase';
import { insertAlert } from '@/lib/notify';
import { sendPushToClient } from '@/lib/push';

export const dynamic = 'force-dynamic';

const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}

async function handle(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const headerSecret = req.headers.get('x-cron-secret');
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
  if (headerSecret !== secret && bearer !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supa = db();
  const now = Date.now();
  const staleBefore = new Date(now - STALE_AFTER_MS).toISOString();
  const lookbackAfter = new Date(now - MAX_LOOKBACK_MS).toISOString();

  const { data: candidates, error: candErr } = await supa
    .from('workouts')
    .select('id, client_id, started_at, clients!inner(name, active)')
    .is('completed_at', null)
    .eq('is_missed', false)
    .lte('started_at', staleBefore)
    .gte('started_at', lookbackAfter);

  if (candErr) {
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }
  const rows = (candidates ?? []).filter(
    // @ts-expect-error supabase nested join typing
    (w) => w.clients?.active === true
  );
  if (rows.length === 0) {
    return NextResponse.json({ ok: true, candidates: 0, fired: 0 });
  }

  // Pull recent workout_stale alerts and dedupe in TS — the recency
  // window matches our 24h candidate cutoff so we never miss a prior fire.
  const { data: priorAlerts } = await supa
    .from('alerts')
    .select('data, created_at')
    .eq('type', 'workout_stale')
    .gte('created_at', lookbackAfter);

  const alreadyFired = new Set(
    (priorAlerts ?? [])
      .map((a) => (a.data as { workout_id?: string } | null)?.workout_id)
      .filter((id): id is string => typeof id === 'string')
  );

  let fired = 0;
  for (const w of rows) {
    if (alreadyFired.has(w.id)) continue;

    const startedAtMs = new Date(w.started_at).getTime();
    const hoursOpen = Math.floor((now - startedAtMs) / (60 * 60 * 1000));
    // @ts-expect-error supabase nested join typing
    const clientName: string = w.clients?.name ?? 'Client';

    await insertAlert({
      clientId: w.client_id,
      type: 'workout_stale',
      message: `${clientName} started ${hoursOpen}h ago and hasn't marked done.`,
      data: { workout_id: w.id, started_at: w.started_at, hours_open: hoursOpen },
    });

    void sendPushToClient(w.client_id, {
      title: 'Still training?',
      body: `Your workout's been open for ${hoursOpen}h — finish it or mark it missed.`,
      url: '/today',
    }).catch(() => {});

    fired++;
  }

  return NextResponse.json({ ok: true, candidates: rows.length, fired });
}
