import { NextResponse } from 'next/server';

import { buildWeeklyReport } from '@/lib/weekly-report';
import { sendPushToCoach } from '@/lib/push';

export const dynamic = 'force-dynamic';

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

  const report = await buildWeeklyReport();

  const onTrack = report.rows.filter((r) => r.daysDone >= r.daysTarget).length;
  const pain = report.rows.filter((r) => r.painExercises > 0).length;
  const behind = report.rows.length - onTrack;

  const lines: string[] = [];
  lines.push(`${onTrack}/${report.rows.length} on track · ${report.totals.completionPct}% volume`);
  if (behind > 0) lines.push(`${behind} behind`);
  if (pain > 0) lines.push(`${pain} flagged pain`);
  if (report.totals.totalPRs > 0) lines.push(`${report.totals.totalPRs} PRs`);

  await sendPushToCoach({
    title: '📊 Weekly report',
    body: lines.join(' · '),
    url: '/coach/weekly',
  });

  return NextResponse.json({
    ok: true,
    weekStart: report.weekStart,
    activeClients: report.rows.length,
    onTrack,
    behind,
    pain,
    totals: report.totals,
  });
}
